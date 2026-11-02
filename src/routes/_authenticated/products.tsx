import { pageHead } from "@/lib/page-head";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useProducts, requireAdmin } from "@/lib/me";
import { useT } from "@/lib/i18n";
import { isValidImeiFormat, money } from "@/lib/imei";
import { Button } from "@/components/ui/button";
import { FileSpreadsheet } from "lucide-react";
import { exportCsv } from "@/lib/export";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageTitle } from "@/components/Stat";
import { useQuery } from "@tanstack/react-query";
import { RecordActions } from "@/components/RecordActions";

export const Route = createFileRoute("/_authenticated/products")({
  beforeLoad: requireAdmin,
  head: () => pageHead("প্রোডাক্ট", "FIROZA ENTERPRISE products, phone stock and IMEI inventory."),
  component: Products,
});

function Products() {
  const { t } = useT();
  const qc = useQueryClient();
  const { data: products = [] } = useProducts();
  const { data: counts = {} } = useQuery({
    queryKey: ["imei-counts"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("distribution_stock_counts");
      if (error) throw error;
      return data as Record<string, number>;
    },
  });
  const [f, setF] = useState({ name: "", model: "", price: "", is_smartphone: true });
  const [imeiFor, setImeiFor] = useState<string | null>(null);
  const [imeiText, setImeiText] = useState("");
  const [addQty, setAddQty] = useState<Record<string, string>>({});
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [savingLimit, setSavingLimit] = useState<string | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["products"] }); qc.invalidateQueries({ queryKey: ["imei-counts"] }); qc.invalidateQueries({ queryKey: ["dashboard-insights"] }); };

  async function saveLimit(id: string, current: number) {
    const raw = limits[id] ?? String(current);
    const limit = Number(raw);
    if (!raw.trim() || !Number.isInteger(limit) || limit < 0) { toast.error(t("invalidThreshold")); return; }
    setSavingLimit(id);
    const { error } = await supabase.from("products").update({ low_stock_threshold: limit }).eq("id", id);
    setSavingLimit(null);
    if (error) { toast.error(error.message); return; }
    toast.success(t("done"));
    refresh();
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabase.from("products").insert({
      name: f.name, model: f.model || null, price: Number(f.price || 0), is_smartphone: f.is_smartphone,
      stock_qty: 0,
    });
    if (error) { toast.error(error.message); return; }
    setF({ name: "", model: "", price: "", is_smartphone: true });
    refresh();
  }

  async function saveImeis() {
    if (!imeiFor) return;
    const list = [...new Set(imeiText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
    const bad = list.filter((i) => !isValidImeiFormat(i));
    if (bad.length) { navigator.vibrate?.(300); { toast.error(`${t("imeiWrong")} ${bad.join(", ")}`); return; } }
    const { error } = await supabase.from("imei_units").insert(list.map((imei) => ({ imei, product_id: imeiFor })));
    if (error) { toast.error(error.message); return; }
    toast.success(`${list.length} IMEI ${t("done")}`);
    setImeiFor(null); setImeiText(""); refresh();
  }

  async function addStock(id: string) {
    const n = Number(addQty[id] || 0);
    if (!Number.isInteger(n) || n <= 0) { toast.error(t("invalidThreshold")); return; }
    const reason = window.prompt(t("reason"));
    if (!reason || reason.trim().length < 3) return;
    const { error } = await supabase.rpc("receive_button_stock", { _product: id, _qty: n, _reason: reason.trim() });
    if (error) { toast.error(error.message); return; }
    setAddQty({ ...addQty, [id]: "" }); refresh();
  }

  function exportStock() {
    const rows: (string | number)[][] = [[t("name"), t("model"), t("price"), t("items"), t("stock")]];
    for (const p of products) {
      rows.push([p.name, p.model ?? "", Number(p.price), p.is_smartphone ? t("smartphone") : t("buttonPhone"), p.is_smartphone ? counts[p.id] ?? 0 : p.stock_qty]);
    }
    exportCsv("stock-list.csv", rows, t("stockReport"));
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageTitle>{t("products")}</PageTitle>
        <Button size="sm" variant="secondary" onClick={exportStock} disabled={!products.length}>
          <FileSpreadsheet className="mr-1 h-4 w-4" />{t("export")}
        </Button>
      </div>
      <form onSubmit={add} className="grid gap-3 rounded-xl border bg-card p-4 md:grid-cols-6">
        <Input required placeholder={t("name")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Input placeholder={t("model")} value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} />
        <Input required type="number" placeholder={t("price")} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
        <label className="flex items-center gap-2 text-sm"><Switch checked={f.is_smartphone} onCheckedChange={(v) => setF({ ...f, is_smartphone: v })} />{f.is_smartphone ? t("smartphone") : t("buttonPhone")}</label>
        <div />
        <Button>{t("add")}</Button>
      </form>
      <div className="grid gap-3 md:grid-cols-2">
        {products.map((p) => (
          <div key={p.id} className="rounded-xl border bg-card p-4">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
              <div className="min-w-0 break-words">
                <div className="font-display text-lg font-bold">{p.name} <span className="text-sm font-normal text-muted-foreground">{p.model}</span></div>
                <div className="text-sm text-muted-foreground">{p.is_smartphone ? t("smartphone") : t("buttonPhone")} · {money(p.price)}</div>
              </div>
              <div className="text-right"><div className="text-xs text-muted-foreground">{t("stock")}</div><div className="font-display text-2xl font-bold">{p.is_smartphone ? counts[p.id] ?? 0 : p.stock_qty}</div></div>
            </div>
            <div className="mt-3 flex gap-2">
              <RecordActions table="products" id={p.id} fields={[{ key: "name", label: "name", value: p.name }, { key: "model", label: "model", value: p.model }, { key: "price", label: "price", value: Number(p.price), type: "number" }]} />
              {p.is_smartphone ? (
                <Button size="sm" variant="secondary" onClick={() => setImeiFor(p.id)}>{t("addImei")}</Button>
              ) : (
                <>
                  <Input className="h-8 w-24" type="number" value={addQty[p.id] ?? ""} onChange={(e) => setAddQty({ ...addQty, [p.id]: e.target.value })} />
                  <Button size="sm" variant="secondary" onClick={() => addStock(p.id)}>+ {t("stock")}</Button>
                </>
              )}
            </div>
            <div className="mt-3 border-t pt-3">
              <Label htmlFor={`limit-${p.id}`}>{t("stockThreshold")}</Label>
              <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <Input id={`limit-${p.id}`} type="number" min={0} step={1} value={limits[p.id] ?? String(p.low_stock_threshold)} onChange={(e) => setLimits({ ...limits, [p.id]: e.target.value })} />
                <Button size="sm" variant="outline" disabled={savingLimit === p.id} onClick={() => saveLimit(p.id, p.low_stock_threshold)}>{t("save")}</Button>
              </div>
              {p.low_stock_threshold === 0 && <p className="mt-1 text-xs text-muted-foreground">{t("thresholdUnset")}</p>}
            </div>
          </div>
        ))}
      </div>
      <Dialog open={!!imeiFor} onOpenChange={(o) => !o && setImeiFor(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("addImei")}</DialogTitle></DialogHeader>
          <Label>{t("imeiList")}</Label>
          <Textarea rows={8} value={imeiText} onChange={(e) => setImeiText(e.target.value)} />
          <Button onClick={saveImeis}>{t("save")}</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
