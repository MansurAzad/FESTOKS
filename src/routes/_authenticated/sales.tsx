import { pageHead } from "@/lib/page-head";
import { createFileRoute } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Printer } from "lucide-react";
import { useMe, useRetailers, useSalesmanSummary } from "@/lib/me";
import { useT } from "@/lib/i18n";
import { money } from "@/lib/imei";
import { useBusiness } from "@/lib/business";
import { runOrQueue, useOnline } from "@/lib/offline";
import { fetchSaleItems } from "@/lib/receipt";
import { PrintSheet, SaleReceiptDoc } from "@/components/PrintDocs";
import { CartBuilder, type CartLine } from "@/components/CartBuilder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageTitle } from "@/components/Stat";

export const Route = createFileRoute("/_authenticated/sales")({
  head: () => pageHead("বিক্রি", "FIROZA ENTERPRISE retailer sales, payments and invoices."),
  component: Sales,
});

function Sales() {
  const { t } = useT();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: retailers = [] } = useRetailers();
  const { data: summary } = useSalesmanSummary(me?.id);
  const [business] = useBusiness();
  const online = useOnline();
  const [rid, setRid] = useState("");
  const [paid, setPaid] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [lastSale, setLastSale] = useState<{ id: string; retailerId: string; total: number; paid: number; date: string } | null>(null);
  const [printDoc, setPrintDoc] = useState<ReactNode | null>(null);
  const total = cart.reduce((a, l) => a + l.qty * l.unit_price, 0);
  const held = summary?.products.filter((p) => p.hand > 0).map((p) => p.product_id) ?? [];

  async function submit() {
    if (!me?.active || (!me.isAdmin && !me.permissions.sales)) return;
    const result = await runOrQueue(
      {
        kind: "record_sale",
        payload: {
          _retailer: rid,
          _items: cart.map((l) => ({ product_id: l.product_id, qty: l.qty, unit_price: l.unit_price, imeis: l.imeis })),
          _paid: Number(paid || 0),
        },
      },
      !online,
    );
    if (result.s === "error") { toast.error(result.error); return; }
    if (result.s === "queued") { toast.success(t("savedOffline")); setCart([]); setPaid(""); return; }
    toast.success(t("done"));
    setLastSale({ id: result.data as string, retailerId: rid, total, paid: Number(paid || 0), date: new Date().toISOString() });
    setCart([]); setPaid("");
    qc.invalidateQueries();
  }

  async function printReceipt() {
    if (!lastSale) return;
    const r = retailers.find((x) => x.id === lastSale.retailerId);
    const items = await fetchSaleItems(lastSale.id);
    setPrintDoc(
      <SaleReceiptDoc b={business} appName={t("appName")} saleId={lastSale.id} date={lastSale.date}
        retailerName={r?.name ?? ""} retailerMeta={r?.phone ?? undefined}
        items={items} total={lastSale.total} paid={lastSale.paid} />,
    );
  }

  if (!me) return null;
  return (
    <div className="space-y-4">
      <PageTitle>{t("sales")}</PageTitle>
      {lastSale && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-success bg-success/10 p-3">
          <span className="text-sm font-semibold">{t("done")} · {money(lastSale.total)}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={printReceipt}><Printer className="mr-1 h-4 w-4" />{t("printReceipt")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setLastSale(null)}>✕</Button>
          </div>
        </div>
      )}
      <Select value={rid} onValueChange={setRid}>
        <SelectTrigger className="w-full sm:w-72"><SelectValue placeholder={t("selectRetailer")} /></SelectTrigger>
        <SelectContent>{retailers.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}</SelectContent>
      </Select>
      <CartBuilder mode="sale" salesmanId={me.id} cart={cart} setCart={setCart} editPrice onlyProductIds={held} />
      <div className="grid grid-cols-2 gap-3 rounded-xl border bg-card p-4">
        <div className="space-y-1"><Label>{t("paid")}</Label><Input type="number" value={paid} onChange={(e) => setPaid(e.target.value)} /></div>
        <div className="text-right"><div className="text-xs text-muted-foreground">{t("due")}</div><div className="font-display text-2xl font-bold text-destructive">{money(total - Number(paid || 0))}</div></div>
      </div>
      <Button size="lg" className="w-full" disabled={(!me.isAdmin && !me.permissions.sales) || !rid || !cart.length || Number(paid || 0) > total} onClick={submit}>{t("confirm")}</Button>
      {printDoc && <PrintSheet onDone={() => setPrintDoc(null)}>{printDoc}</PrintSheet>}
    </div>
  );
}
