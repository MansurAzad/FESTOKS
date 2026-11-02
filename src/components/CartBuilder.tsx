import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useProducts, useSalesmanSummary } from "@/lib/me";
import { isNetworkFailure, useOnline } from "@/lib/offline";
import { useT } from "@/lib/i18n";
import { money } from "@/lib/imei";
import { ImeiScanner } from "./ImeiScanner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type CartLine = { product_id: string; name: string; isSmart: boolean; qty: number; unit_price: number; imeis: string[] };

/** Builds a list of products; smartphones are added only by validated IMEI scans. */
export function CartBuilder({
  mode, salesmanId, cart, setCart, editPrice, onlyProductIds,
}: {
  mode: "issue" | "sale" | "return";
  salesmanId: string;
  cart: CartLine[];
  setCart: (c: CartLine[]) => void;
  editPrice?: boolean;
  onlyProductIds?: string[];
}) {
  const { t } = useT();
  const { data: products = [] } = useProducts();
  const online = useOnline();
  // Salesman's held IMEIs (cached) let sale/return scans be checked while offline.
  const { data: summary } = useSalesmanSummary(mode === "issue" ? undefined : salesmanId);
  const [pid, setPid] = useState("");
  const [qty, setQty] = useState("1");
  const buttonProducts = products.filter((p) => !p.is_smartphone && (!onlyProductIds || onlyProductIds.includes(p.id)));

  async function validate(imei: string) {
    if (cart.some((l) => l.imeis.includes(imei))) return { ok: false, message: "duplicate" };
    if (!salesmanId) return { ok: false, message: t("selectSalesman") };
    const { data, error } = await supabase.rpc("check_imei", { _imei: imei, _mode: mode, _salesman: salesmanId });
    if (error && isNetworkFailure(error, !online)) {
      // Offline: validate against the salesman's cached held-IMEI list; the
      // database function re-validates when the queued entry syncs.
      const held = summary?.handImeis.find((i) => i.imei === imei);
      if (!held) return { ok: false, message: t("imeiOffline") };
      const p = products.find((x) => x.id === held.product_id);
      if (!p) return { ok: false, message: t("imeiOffline") };
      const next = [...cart];
      const line = next.find((l) => l.product_id === p.id);
      if (line) { line.imeis = [...line.imeis, imei]; line.qty = line.imeis.length; }
      else next.push({ product_id: p.id, name: p.name, isSmart: true, qty: 1, unit_price: Number(p.price), imeis: [imei] });
      setCart(next);
      return { ok: true, message: p.name };
    }
    const r = data as { ok: boolean; reason?: string; product_id?: string; product_name?: string; price?: number } | null;
    if (error || !r?.ok) return { ok: false, message: error?.message ?? r?.reason };
    if (!r.product_id || !r.product_name) return { ok: false, message: t("imeiWrong") };
    const next = [...cart];
    const line = next.find((l) => l.product_id === r.product_id);
    if (line) { line.imeis = [...line.imeis, imei]; line.qty = line.imeis.length; }
    else next.push({ product_id: r.product_id, name: r.product_name, isSmart: true, qty: 1, unit_price: Number(r.price), imeis: [imei] });
    setCart(next);
    return { ok: true, message: r.product_name };
  }

  function addButton() {
    const p = products.find((x) => x.id === pid);
    const n = Number(qty);
    if (!p || n <= 0) return;
    const next = cart.filter((l) => l.product_id !== p.id);
    const prev = cart.find((l) => l.product_id === p.id);
    next.push({ product_id: p.id, name: p.name, isSmart: false, qty: (prev?.qty ?? 0) + n, unit_price: Number(p.price), imeis: [] });
    setCart(next);
    setQty("1");
  }

  const total = cart.reduce((a, l) => a + l.qty * l.unit_price, 0);
  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-4">
        <div className="mb-2 text-sm font-semibold">{t("smartphone")}</div>
        <ImeiScanner validate={validate} />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-lg border bg-card p-4 sm:grid-cols-[minmax(0,1fr)_6rem_auto]">
        <div className="col-span-full text-sm font-semibold">{t("buttonPhone")}</div>
        <Select value={pid} onValueChange={setPid}>
          <SelectTrigger className="col-span-full w-full min-w-0 sm:col-span-1"><SelectValue placeholder={t("selectProduct")} /></SelectTrigger>
          <SelectContent>{buttonProducts.map((p) => <SelectItem key={p.id} value={p.id}>{p.name} {mode === "issue" ? `(${p.stock_qty})` : ""}</SelectItem>)}</SelectContent>
        </Select>
        <Input className="w-full min-w-0" type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />
        <Button type="button" variant="secondary" onClick={addButton}>{t("add")}</Button>
      </div>
      <div className="rounded-xl border bg-card p-4">
        <div className="mb-2 text-sm font-semibold">{t("items")}</div>
        {cart.length === 0 && <p className="text-sm text-muted-foreground">{t("noData")}</p>}
        {cart.map((l, i) => (
          <div key={l.product_id} className="flex flex-wrap items-center gap-2 border-b py-2 text-sm last:border-0">
            <span className="min-w-0 flex-1 basis-full break-words font-medium sm:basis-auto">{l.name} × {l.qty}</span>
            {editPrice ? (
              <Input className="h-8 w-28" type="number" value={l.unit_price} onChange={(e) => { const n = [...cart]; n[i] = { ...l, unit_price: Number(e.target.value) }; setCart(n); }} />
            ) : <span>{money(l.unit_price)}</span>}
            <span className="w-24 text-right font-semibold">{money(l.qty * l.unit_price)}</span>
            <Button type="button" size="sm" variant="ghost" onClick={() => setCart(cart.filter((x) => x !== l))}>✕</Button>
            {l.isSmart && <div className="w-full break-words text-xs text-muted-foreground">{l.imeis.join(", ")}</div>}
          </div>
        ))}
        <div className="mt-2 text-right font-display text-lg font-bold">{t("total")}: {money(total)}</div>
      </div>
    </div>
  );
}
