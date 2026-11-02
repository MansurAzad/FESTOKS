import { pageHead } from "@/lib/page-head";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSalesmen, requireAdmin } from "@/lib/me";
import { runOrQueue, useOnline } from "@/lib/offline";
import { useT } from "@/lib/i18n";
import { CartBuilder, type CartLine } from "@/components/CartBuilder";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageTitle } from "@/components/Stat";

export const Route = createFileRoute("/_authenticated/stock-issue")({
  beforeLoad: requireAdmin,
  head: () => pageHead("মাল দেওয়া", "FIROZA ENTERPRISE stock issue and validated smartphone IMEI transfers."),
  component: StockIssue,
});

function StockIssue() {
  const { t } = useT();
  const qc = useQueryClient();
  const { data: salesmen = [] } = useSalesmen();
  const [sid, setSid] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const online = useOnline();

  async function submit() {
    if (!sid || !cart.length) return;
    const result = await runOrQueue(
      { kind: "issue_stock", payload: { _salesman: sid, _items: cart.map((l) => ({ product_id: l.product_id, qty: l.qty, imeis: l.imeis })) } },
      !online,
    );
    if (result.s === "error") { toast.error(result.error); return; }
    toast.success(t(result.s === "queued" ? "savedOffline" : "done"));
    setCart([]);
    qc.invalidateQueries();
  }

  return (
    <div className="space-y-4">
      <PageTitle>{t("stockIssue")}</PageTitle>
      <Select value={sid} onValueChange={(v) => { setSid(v); setCart([]); }}>
        <SelectTrigger className="w-full sm:w-72"><SelectValue placeholder={t("selectSalesman")} /></SelectTrigger>
        <SelectContent>{salesmen.filter((s) => s.active).map((s) => <SelectItem key={s.id} value={s.id}>{s.full_name}</SelectItem>)}</SelectContent>
      </Select>
      {sid && <CartBuilder mode="issue" salesmanId={sid} cart={cart} setCart={setCart} />}
      <Button size="lg" className="w-full" disabled={!sid || !cart.length} onClick={submit}>{t("confirm")}</Button>
    </div>
  );
}
