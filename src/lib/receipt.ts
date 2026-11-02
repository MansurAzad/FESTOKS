import { supabase } from "@/integrations/supabase/client";
import type { ReceiptItem } from "@/components/PrintDocs";

/** Loads the sold items (with IMEIs) of one sale for printing a receipt. */
export async function fetchSaleItems(saleId: string): Promise<ReceiptItem[]> {
  const { data } = await supabase
    .from("stock_movements")
    .select("qty, unit_price, imei, products(name)")
    .eq("sale_id", saleId)
    .eq("kind", "sale");
  const by: Record<string, ReceiptItem> = {};
  for (const m of data ?? []) {
    const name = (m.products as { name: string } | null)?.name ?? "";
    const it = (by[name] ??= { name, qty: 0, unit_price: Number(m.unit_price), imeis: [] });
    it.qty += m.qty;
    if (m.imei) it.imeis.push(m.imei);
  }
  return Object.values(by);
}
