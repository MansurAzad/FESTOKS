import { pageHead } from "@/lib/page-head";
import { createFileRoute } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileSpreadsheet, Printer } from "lucide-react";
import { useMe, useSalesmanSummary, useSalesmen } from "@/lib/me";
import { useT } from "@/lib/i18n";
import { money } from "@/lib/imei";
import { exportCsv } from "@/lib/export";
import { useBusiness } from "@/lib/business";
import { runOrQueue, useOnline } from "@/lib/offline";
import { MoneyReceiptDoc, PrintSheet, SettlementDoc } from "@/components/PrintDocs";
import { CartBuilder, type CartLine } from "@/components/CartBuilder";
import { SalesmanSummary } from "@/components/SalesmanSummary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageTitle } from "@/components/Stat";

export const Route = createFileRoute("/_authenticated/settlement")({
  head: () => pageHead("ফেরত ও জমা", "FIROZA ENTERPRISE returns, damage, deposits and settlement reports."),
  component: Settlement,
});

function Settlement() {
  const { t } = useT();
  const { data: me } = useMe();
  const { data: salesmen = [] } = useSalesmen();
  const [picked, setPicked] = useState("");
  if (!me) return null;
  const sid = me.isAdmin ? picked : me.id;
  const name = me.isAdmin ? (salesmen.find((s) => s.id === sid)?.full_name ?? "") : (me.profile?.full_name || me.email || "");
  return (
    <div className="space-y-6">
      <PageTitle>{t("settlement")}</PageTitle>
      {me.isAdmin && (
        <Select value={picked} onValueChange={setPicked}>
          <SelectTrigger className="w-full sm:w-72"><SelectValue placeholder={t("selectSalesman")} /></SelectTrigger>
          <SelectContent>{salesmen.map((s) => <SelectItem key={s.id} value={s.id}>{s.full_name}</SelectItem>)}</SelectContent>
        </Select>
      )}
      {sid && (
        <>
          <SalesmanSummary salesmanId={sid} />
          <ReportBox salesmanId={sid} salesmanName={name} />
          {(me.isAdmin || me.permissions.returns) && <ReturnBox key={"r" + sid} salesmanId={sid} />}
          {me.isAdmin && <DepositBox key={"d" + sid} salesmanId={sid} />}
          <DepositHistory salesmanId={sid} salesmanName={name} />
        </>
      )}
    </div>
  );
}

function ReportBox({ salesmanId, salesmanName }: { salesmanId: string; salesmanName: string }) {
  const { t } = useT();
  const [business] = useBusiness();
  const [printDoc, setPrintDoc] = useState<ReactNode | null>(null);
  const { data } = useSalesmanSummary(salesmanId);
  if (!data) return null;

  function exportReport() {
    const d = data;
    if (!d) return;
    const rows: (string | number)[][] = [
      [t("settlementReport"), salesmanName],
      [],
      [t("products"), t("issued"), t("sold"), t("returned"), t("damaged"), t("inHand"), t("goodsValue")],
      ...d.products.map((p) => [p.name, p.issued, p.sold, p.returned, p.damaged, p.hand, Math.round(p.value)]),
      [],
      [t("sales"), Math.round(d.salesTotal)],
      [t("retailerDue"), Math.round(d.retailerDue)],
      [t("cashInHand"), Math.round(d.cashInHand)],
      [t("deposited"), Math.round(d.deposited)],
      [t("owesDealer"), Math.round(d.owesDealer)],
    ];
    exportCsv(`settlement-${salesmanName || "report"}.csv`, rows, t("settlementReport"));
  }

  function printReport() {
    const d = data;
    if (!d) return;
    setPrintDoc(
      <SettlementDoc b={business} appName={t("appName")} salesmanName={salesmanName} products={d.products}
        salesTotal={d.salesTotal} cashInHand={d.cashInHand} deposited={d.deposited}
        retailerDue={d.retailerDue} owesDealer={d.owesDealer} />,
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" onClick={exportReport}><FileSpreadsheet className="mr-1 h-4 w-4" />{t("export")}</Button>
      <Button size="sm" variant="secondary" onClick={printReport}><Printer className="mr-1 h-4 w-4" />{t("print")}</Button>
      {printDoc && <PrintSheet onDone={() => setPrintDoc(null)}>{printDoc}</PrintSheet>}
    </div>
  );
}

function ReturnBox({ salesmanId }: { salesmanId: string }) {
  const { t } = useT();
  const qc = useQueryClient();
  const { data: summary } = useSalesmanSummary(salesmanId);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [damaged, setDamaged] = useState(false);
  const online = useOnline();
  const held = summary?.products.filter((p) => p.hand > 0).map((p) => p.product_id) ?? [];
  async function submit() {
    const result = await runOrQueue(
      { kind: "return_stock", payload: { _salesman: salesmanId, _items: cart.map((l) => ({ product_id: l.product_id, qty: l.qty, imeis: l.imeis, damaged })) } },
      !online,
    );
    if (result.s === "error") { navigator.vibrate?.(300); toast.error(result.error); return; }
    toast.success(t(result.s === "queued" ? "savedOffline" : "done"));
    setCart([]);
    qc.invalidateQueries();
  }
  return (
    <section className="space-y-3 rounded-2xl border-2 border-dashed p-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <h2 className="font-display text-lg font-bold">{t("returnGoods")}</h2>
        <label className="flex items-center gap-2 text-sm"><Switch checked={damaged} onCheckedChange={setDamaged} />{t("markDamaged")}</label>
      </div>
      {summary && summary.handImeis.length > 0 && (
        <p className="break-words text-xs text-muted-foreground">{t("inHand")} IMEI: {summary.handImeis.map((i) => i.imei).join(", ")}</p>
      )}
      <CartBuilder mode="return" salesmanId={salesmanId} cart={cart} setCart={setCart} onlyProductIds={held} />
      <Button className="w-full" variant={damaged ? "destructive" : "default"} disabled={!cart.length} onClick={submit}>
        {t("confirm")} {damaged ? `(${t("damaged")})` : ""}
      </Button>
    </section>
  );
}

function DepositBox({ salesmanId }: { salesmanId: string }) {
  const { t } = useT();
  const qc = useQueryClient();
  const { data } = useSalesmanSummary(salesmanId);
  const [amt, setAmt] = useState("");
  const [note, setNote] = useState("");
  const online = useOnline();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(amt);
    if (n <= 0) return;
    const result = await runOrQueue({ kind: "deposit", payload: { salesman_id: salesmanId, amount: n, note: note || null } }, !online);
    if (result.s === "error") { toast.error(result.error); return; }
    setAmt(""); setNote(""); toast.success(t(result.s === "queued" ? "savedOffline" : "done"));
    qc.invalidateQueries();
  }
  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border bg-accent/10 p-4">
      <h2 className="font-display text-lg font-bold">{t("deposit")}</h2>
      <p className="text-sm">{t("cashInHand")}: <b>{money(data?.cashInHand)}</b></p>
      <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
        <Input className="w-full" type="number" placeholder={t("amount")} value={amt} onChange={(e) => setAmt(e.target.value)} />
        <Input className="flex-1" placeholder="Note" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button>{t("save")}</Button>
      </div>
    </form>
  );
}

function DepositHistory({ salesmanId, salesmanName }: { salesmanId: string; salesmanName: string }) {
  const { t } = useT();
  const [business] = useBusiness();
  const [printDoc, setPrintDoc] = useState<ReactNode | null>(null);
  const { data } = useSalesmanSummary(salesmanId);
  if (!data?.deposits.length) return null;
  return (
    <section className="rounded-xl border bg-card p-4">
      <h2 className="mb-2 font-display font-bold">{t("deposited")} · {t("history")}</h2>
      {data.deposits.map((d) => (
        <div key={d.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b py-2 text-sm last:border-0 sm:flex">
          <span className="min-w-0 flex-1 truncate">{money(d.amount)} {d.note && <span className="text-muted-foreground">— {d.note}</span>}</span>
          <span className="row-start-2 text-xs text-muted-foreground sm:shrink-0">{new Date(d.created_at).toLocaleString()}</span>
          <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2" title={t("printReceipt")}
            onClick={() => setPrintDoc(
              <MoneyReceiptDoc b={business} appName={t("appName")} receiptId={d.id} date={d.created_at}
                fromName={salesmanName} amount={Number(d.amount)} note={d.note} receivedBy={business.name || t("businessOwner")} />,
            )}>
            <Printer className="h-4 w-4" />
          </Button>
        </div>
      ))}
      {printDoc && <PrintSheet onDone={() => setPrintDoc(null)}>{printDoc}</PrintSheet>}
    </section>
  );
}
