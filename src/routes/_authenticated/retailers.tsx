import { pageHead } from "@/lib/page-head";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileSpreadsheet, Printer } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useMe, useRetailers, useSalesmen } from "@/lib/me";
import { useT } from "@/lib/i18n";
import { money } from "@/lib/imei";
import { exportCsv } from "@/lib/export";
import { useBusiness } from "@/lib/business";
import { runOrQueue, useOnline } from "@/lib/offline";
import { fetchSaleItems } from "@/lib/receipt";
import { LedgerDoc, MoneyReceiptDoc, PrintSheet, SaleReceiptDoc } from "@/components/PrintDocs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageTitle } from "@/components/Stat";
import { RecordActions } from "@/components/RecordActions";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type SaleRow = { id: string; created_at: string; total: number; paid: number; retailer_id: string };
type PayRow = { id: string; created_at: string; amount: number; note: string | null; retailer_id: string };
type RetailerRow = { id: string; name: string; phone: string | null; address: string | null };

export const Route = createFileRoute("/_authenticated/retailers")({
  head: () => pageHead("রিটেইলার লেজার", "FIROZA ENTERPRISE retailer ledgers, collections and outstanding balances."),
  component: Retailers,
});

function Retailers() {
  const { t } = useT();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: salesmen = [] } = useSalesmen();
  const [salesmanId, setSalesmanId] = useState("");
  const online = useOnline();
  const { data: retailers = [] } = useRetailers();
  const [business] = useBusiness();
  const [f, setF] = useState({ name: "", phone: "", address: "" });
  const [open, setOpen] = useState<string | null>(null);
  const [printDoc, setPrintDoc] = useState<ReactNode | null>(null);
  const { data: ledger } = useQuery({
    queryKey: ["ledger"],
    queryFn: async () => {
      const [s, p] = await Promise.all([
        supabase.from("sales").select("id,created_at,total,paid,retailer_id").order("created_at", { ascending: false }),
        supabase.from("retailer_payments").select("id,created_at,amount,note,retailer_id").order("created_at", { ascending: false }),
      ]);
      if (s.error) throw s.error;
      if (p.error) throw p.error;
      return { sales: (s.data ?? []) as SaleRow[], pays: (p.data ?? []) as PayRow[] };
    },
  });

  const appName = t("appName");
  const grouped = useMemo(() => {
    const sales = new Map<string, SaleRow[]>();
    const pays = new Map<string, PayRow[]>();
    for (const row of ledger?.sales ?? []) { const list = sales.get(row.retailer_id) ?? []; list.push(row); sales.set(row.retailer_id, list); }
    for (const row of ledger?.pays ?? []) { const list = pays.get(row.retailer_id) ?? []; list.push(row); pays.set(row.retailer_id, list); }
    const balances = new Map<string, { total: number; paid: number }>();
    for (const [id, list] of sales) balances.set(id, { total: list.reduce((n,r) => n + Number(r.total),0), paid: list.reduce((n,r) => n + Number(r.paid),0) });
    for (const [id, list] of pays) { const b = balances.get(id) ?? { total: 0, paid: 0 }; b.paid += list.reduce((n,r) => n + Number(r.amount),0); balances.set(id,b); }
    return { sales, pays, balances };
  }, [ledger]);
  const salesOf = (r: RetailerRow) => grouped.sales.get(r.id) ?? [];
  const paysOf = (r: RetailerRow) => grouped.pays.get(r.id) ?? [];
  const totalOf = (r: RetailerRow) => grouped.balances.get(r.id)?.total ?? 0;
  const paidOf = (r: RetailerRow) => grouped.balances.get(r.id)?.paid ?? 0;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!me) return;
    if (me.isAdmin && !salesmanId) { toast.error(t("selectSalesman")); return; }
    const result = await runOrQueue({ kind: "add_retailer", payload: { ...f, salesman_id: me.isAdmin ? salesmanId : me.id } }, !online);
    if (result.s === "error") { toast.error(result.error); return; }
    if (result.s === "queued") toast.success(t("savedOffline"));
    setF({ name: "", phone: "", address: "" });
    qc.invalidateQueries({ queryKey: ["retailers"] });
  }

  function exportAll() {
    const rows: (string | number)[][] = [[t("name"), t("phone"), t("address"), t("total"), t("paid"), t("due")]];
    for (const r of retailers) rows.push([r.name, r.phone ?? "", r.address ?? "", totalOf(r), paidOf(r), totalOf(r) - paidOf(r)]);
    exportCsv("retailer-ledger.csv", rows, t("retailers"));
  }

  function exportOne(r: RetailerRow) {
    const rows: (string | number)[][] = [[t("date"), t("items"), t("sales"), t("paid")]];
    for (const s of salesOf(r)) rows.push([new Date(s.created_at).toLocaleString(), `${t("sales")} (${t("paid")} ${money(s.paid)})`, Number(s.total), Number(s.paid)]);
    for (const p of paysOf(r)) rows.push([new Date(p.created_at).toLocaleString(), `${t("collectPayment")}${p.note ? ` — ${p.note}` : ""}`, "", Number(p.amount)]);
    rows.push([], [t("total"), "", totalOf(r), paidOf(r)], [t("due"), "", "", totalOf(r) - paidOf(r)]);
    exportCsv(`ledger-${r.name}.csv`, rows, r.name);
  }

  function printLedger(r: RetailerRow) {
    const entries = [
      ...salesOf(r).map((s) => ({ date: s.created_at, label: `${t("sales")} (${t("paid")} ${money(s.paid)})`, debit: Number(s.total), credit: 0 })),
      ...paysOf(r).map((p) => ({ date: p.created_at, label: `${t("collectPayment")}${p.note ? ` — ${p.note}` : ""}`, debit: 0, credit: Number(p.amount) })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    setPrintDoc(
      <LedgerDoc b={business} appName={appName} retailerName={r.name} retailerMeta={[r.phone, r.address].filter(Boolean).join(" · ") || undefined}
        entries={entries} total={totalOf(r)} paid={paidOf(r)} />,
    );
  }

  async function printSaleReceipt(s: SaleRow, r: RetailerRow) {
    const items = await fetchSaleItems(s.id);
    setPrintDoc(
      <SaleReceiptDoc b={business} appName={appName} saleId={s.id} date={s.created_at} retailerName={r.name}
        retailerMeta={r.phone ?? undefined} items={items} total={Number(s.total)} paid={Number(s.paid)} />,
    );
  }

  function printPayReceipt(p: PayRow, r: RetailerRow) {
    setPrintDoc(
      <MoneyReceiptDoc b={business} appName={appName} receiptId={p.id} date={p.created_at} fromName={r.name}
        fromMeta={r.phone ?? undefined} amount={Number(p.amount)} note={p.note} receivedBy={me?.profile?.full_name || ""} />,
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageTitle>{t("retailers")} · {t("ledger")}</PageTitle>
        <Button size="sm" variant="secondary" onClick={exportAll} disabled={!retailers.length}>
          <FileSpreadsheet className="mr-1 h-4 w-4" />{t("export")}
        </Button>
      </div>
      {me && (me.isAdmin || me.permissions.retailer_manage) && (
        <form onSubmit={add} className="grid gap-3 rounded-xl border bg-card p-4 md:grid-cols-4">
          {me.isAdmin && <Select value={salesmanId} onValueChange={setSalesmanId}><SelectTrigger><SelectValue placeholder={t("selectSalesman")} /></SelectTrigger><SelectContent>{salesmen.map((s) => <SelectItem key={s.id} value={s.id}>{s.full_name}</SelectItem>)}</SelectContent></Select>}
          <Input required placeholder={t("name")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Input placeholder={t("phone")} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          <Input placeholder={t("address")} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
          <Button>{t("add")}</Button>
        </form>
      )}
      <div className="space-y-3">
        {retailers.map((r) => {
          const sales = salesOf(r);
          const pays = paysOf(r);
          const total = totalOf(r);
          const paid = paidOf(r);
          const entries = [
            ...sales.map((s) => ({ kind: "sale" as const, at: s.created_at, sale: s })),
            ...pays.map((p) => ({ kind: "pay" as const, at: p.created_at, pay: p })),
          ].sort((a, b) => b.at.localeCompare(a.at));
          return (
            <div key={r.id} className="rounded-xl border bg-card p-4">
              <button className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-left sm:flex sm:flex-wrap sm:gap-3" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-display font-bold">{r.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{r.phone} {r.address}</div>
                </div>
                <span className="text-sm">{t("total")}: {money(total)}</span>
                <span className="text-sm text-success">{t("paid")}: {money(paid)}</span>
                <span className="font-bold text-destructive">{t("due")}: {money(total - paid)}</span>
              </button>
              {open === r.id && (
                <div className="mt-3 space-y-3 border-t pt-3">
                  {!me?.isAdmin && me?.permissions.collect_payment && <PaymentForm retailerId={r.id} max={total - paid} />}
                  <div className="flex flex-wrap gap-2">
                    {(me?.isAdmin || me?.permissions.retailer_manage) && <RecordActions table="retailers" id={r.id} fields={[{ key: "name", label: "name", value: r.name }, { key: "phone", label: "phone", value: r.phone }, { key: "address", label: "address", value: r.address }]} />}
                    <Button size="sm" variant="secondary" onClick={() => exportOne(r)}><FileSpreadsheet className="mr-1 h-4 w-4" />{t("export")}</Button>
                    <Button size="sm" variant="secondary" onClick={() => printLedger(r)}><Printer className="mr-1 h-4 w-4" />{t("print")}</Button>
                  </div>
                  <div className="space-y-1 text-sm">
                    {entries.map((e) => (
                      <div key={e.kind + (e.kind === "sale" ? e.sale.id : e.pay.id)} className="flex items-center justify-between gap-2 rounded bg-muted px-2 py-1">
                        {e.kind === "sale" ? (
                          <>
                            <span className="min-w-0 flex-1 truncate">{t("sales")} {money(e.sale.total)} · {t("paid")} {money(e.sale.paid)}</span>
                            <span className="shrink-0 text-muted-foreground">{new Date(e.at).toLocaleDateString()}</span>
                            <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2" onClick={() => printSaleReceipt(e.sale, r)} title={t("printReceipt")}><Printer className="h-4 w-4" /></Button>
                          </>
                        ) : (
                          <>
                            <span className="min-w-0 flex-1 truncate">{t("collectPayment")} {money(e.pay.amount)}{e.pay.note ? ` — ${e.pay.note}` : ""}</span>
                            <span className="shrink-0 text-muted-foreground">{new Date(e.at).toLocaleDateString()}</span>
                            <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2" onClick={() => printPayReceipt(e.pay, r)} title={t("printReceipt")}><Printer className="h-4 w-4" /></Button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {retailers.length === 0 && <p className="text-muted-foreground">{t("noData")}</p>}
      </div>
      {printDoc && <PrintSheet onDone={() => setPrintDoc(null)}>{printDoc}</PrintSheet>}
    </div>
  );
}

function PaymentForm({ retailerId, max }: { retailerId: string; max: number }) {
  const { t } = useT();
  const qc = useQueryClient();
  const [amt, setAmt] = useState("");
  const online = useOnline();
  async function pay(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(amt);
    if (n <= 0 || n > max) { toast.error(`${t("due")}: ${money(max)}`); return; }
    const result = await runOrQueue({ kind: "retailer_payment", payload: { retailer_id: retailerId, amount: n } }, !online);
    if (result.s === "error") { toast.error(result.error); return; }
    setAmt(""); toast.success(t(result.s === "queued" ? "savedOffline" : "done"));
    qc.invalidateQueries();
  }
  return (
    <form onSubmit={pay} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
      <Input type="number" placeholder={t("amount")} value={amt} onChange={(e) => setAmt(e.target.value)} />
      <Button>{t("collectPayment")}</Button>
    </form>
  );
}
