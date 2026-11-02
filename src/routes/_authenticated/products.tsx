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
import { runOrQueue, useOnline } from "@/lib/offline";
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
  const online = useOnline();
  const [f, setF] = useState({ name: "", model: "", price: "", is_smartphone: true });
  const [receiptFor, setReceiptFor] = useState<string | null>(null);
  const [receiptForm, setReceiptForm] = useState({
    supplier: "",
    purchaseReference: "",
    batchReference: "",
    quantity: "",
    unitCost: "",
    receivedOn: "",
    note: "",
  });
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [historyPage, setHistoryPage] = useState(0);
  const [search, setSearch] = useState("");
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [imeiText, setImeiText] = useState("");
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [savingLimit, setSavingLimit] = useState<string | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["products"] });
    qc.invalidateQueries({ queryKey: ["imei-counts"] });
    qc.invalidateQueries({ queryKey: ["dashboard-insights"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
    qc.invalidateQueries({ queryKey: ["stock-receipts"] });
  };
  const selectedProduct = products.find((p) => p.id === receiptFor);
  const historyProduct = products.find((p) => p.id === historyFor);
  const visibleProducts = products.filter((p) => {
    const text = `${p.name} ${p.model ?? ""}`.toLocaleLowerCase();
    const stock = p.is_smartphone ? (counts[p.id] ?? 0) : p.stock_qty;
    return (
      text.includes(search.trim().toLocaleLowerCase()) &&
      (!lowStockOnly || (p.low_stock_threshold > 0 && stock <= p.low_stock_threshold))
    );
  });
  const {
    data: receiptHistory = [],
    isLoading: historyLoading,
    error: historyError,
  } = useQuery({
    queryKey: ["stock-receipts", historyFor, historyPage],
    enabled: !!historyFor,
    queryFn: async () => {
      if (!historyFor) return [];
      const { data, error } = await supabase
        .from("stock_receipts")
        .select("*")
        .eq("product_id", historyFor)
        .order("received_on", { ascending: false })
        .order("receipt_order", { ascending: false })
        .range(historyPage * 50, historyPage * 50 + 49);
      if (error) throw error;
      return data;
    },
  });
  const receiverIds = [
    ...new Set(
      receiptHistory.flatMap((receipt) => (receipt.created_by ? [receipt.created_by] : [])),
    ),
  ];
  const { data: receiptCreators = [], error: receiptCreatorsError } = useQuery({
    queryKey: ["receipt-creators", receiverIds],
    enabled: receiverIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,full_name")
        .in("id", receiverIds);
      if (error) throw error;
      return data;
    },
  });

  async function saveLimit(id: string, current: number) {
    const raw = limits[id] ?? String(current);
    const limit = Number(raw);
    if (!raw.trim() || !Number.isInteger(limit) || limit < 0) {
      toast.error(t("invalidThreshold"));
      return;
    }
    setSavingLimit(id);
    const { error } = await supabase
      .from("products")
      .update({ low_stock_threshold: limit })
      .eq("id", id);
    setSavingLimit(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(t("done"));
    refresh();
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabase.from("products").insert({
      name: f.name,
      model: f.model || null,
      price: Number(f.price || 0),
      is_smartphone: f.is_smartphone,
      stock_qty: 0,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    setF({ name: "", model: "", price: "", is_smartphone: true });
    refresh();
  }

  function openReceipt(id: string) {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    setReceiptForm({
      supplier: "",
      purchaseReference: "",
      batchReference: "",
      quantity: "",
      unitCost: "",
      receivedOn: now.toISOString().slice(0, 10),
      note: "",
    });
    setImeiText("");
    setReceiptFor(id);
  }

  async function saveReceipt() {
    if (!selectedProduct) return;
    const imeis = selectedProduct.is_smartphone
      ? imeiText
          .split(/[\s,]+/)
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
    if (selectedProduct.is_smartphone) {
      if (!imeis.length) {
        toast.error(t("imeiList"));
        return;
      }
      if (new Set(imeis).size !== imeis.length) {
        toast.error(t("duplicateImei"));
        return;
      }
      const bad = imeis.filter((imei) => !isValidImeiFormat(imei));
      if (bad.length) {
        navigator.vibrate?.(300);
        toast.error(`${t("imeiWrong")} ${bad.join(", ")}`);
        return;
      }
    }
    const quantity = selectedProduct.is_smartphone ? imeis.length : Number(receiptForm.quantity);
    const unitCost = Number(receiptForm.unitCost);
    if (
      !Number.isInteger(quantity) ||
      quantity <= 0 ||
      !receiptForm.unitCost.trim() ||
      !Number.isFinite(unitCost) ||
      unitCost < 0 ||
      !receiptForm.supplier.trim() ||
      !receiptForm.purchaseReference.trim() ||
      !receiptForm.receivedOn
    ) {
      toast.error(t("invalidReceipt"));
      return;
    }
    const result = await runOrQueue(
      {
        kind: "receive_stock",
        payload: {
          _product: selectedProduct.id,
          _imeis: imeis,
          _quantity: quantity,
          _supplier: receiptForm.supplier.trim(),
          _purchase_reference: receiptForm.purchaseReference.trim(),
          _batch_reference: receiptForm.batchReference.trim() || null,
          _unit_cost: unitCost,
          _received_on: receiptForm.receivedOn,
          _note: receiptForm.note.trim() || null,
        },
      },
      !online,
    );
    if (result.s === "error") {
      toast.error(result.error);
      return;
    }
    toast.success(result.s === "queued" ? t("savedOffline") : t("done"));
    setReceiptFor(null);
    refresh();
  }

  function exportStock() {
    const rows: (string | number)[][] = [
      [t("name"), t("model"), t("price"), t("items"), t("stock")],
    ];
    for (const p of products) {
      rows.push([
        p.name,
        p.model ?? "",
        Number(p.price),
        p.is_smartphone ? t("smartphone") : t("buttonPhone"),
        p.is_smartphone ? (counts[p.id] ?? 0) : p.stock_qty,
      ]);
    }
    exportCsv("stock-list.csv", rows, t("stockReport"));
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageTitle>{t("products")}</PageTitle>
        <Button size="sm" variant="secondary" onClick={exportStock} disabled={!products.length}>
          <FileSpreadsheet className="mr-1 h-4 w-4" />
          {t("export")}
        </Button>
      </div>
      <form onSubmit={add} className="grid gap-3 rounded-xl border bg-card p-4 md:grid-cols-6">
        <Input
          required
          placeholder={t("name")}
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
        />
        <Input
          placeholder={t("model")}
          value={f.model}
          onChange={(e) => setF({ ...f, model: e.target.value })}
        />
        <Input
          required
          type="number"
          min={0}
          step="0.01"
          placeholder={t("sellingPrice")}
          value={f.price}
          onChange={(e) => setF({ ...f, price: e.target.value })}
        />
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={f.is_smartphone}
            onCheckedChange={(v) => setF({ ...f, is_smartphone: v })}
          />
          {f.is_smartphone ? t("smartphone") : t("buttonPhone")}
        </label>
        <div />
        <Button>{t("add")}</Button>
      </form>
      <div className="grid gap-2 rounded-xl border bg-card p-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Input
          placeholder={t("searchProduct")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={lowStockOnly}
            onChange={(e) => setLowStockOnly(e.target.checked)}
          />
          {t("lowStockOnly")}
        </label>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {visibleProducts.map((p) => (
          <div key={p.id} className="rounded-xl border bg-card p-4">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
              <div className="min-w-0 break-words">
                <div className="font-display text-lg font-bold">
                  {p.name}{" "}
                  <span className="text-sm font-normal text-muted-foreground">{p.model}</span>
                </div>
                <div className="text-sm text-muted-foreground">
                  {p.is_smartphone ? t("smartphone") : t("buttonPhone")} · {t("sellingPrice")}:{" "}
                  {money(p.selling_price)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t("latestPurchaseCost")}:{" "}
                  {p.cost_price === null ? t("unknownCost") : money(p.cost_price)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-muted-foreground">{t("stock")}</div>
                <div className="font-display text-2xl font-bold">
                  {p.is_smartphone ? (counts[p.id] ?? 0) : p.stock_qty}
                </div>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <RecordActions
                table="products"
                id={p.id}
                fields={[
                  { key: "name", label: "name", value: p.name },
                  { key: "model", label: "model", value: p.model },
                  {
                    key: "price",
                    label: "sellingPrice",
                    value: Number(p.selling_price),
                    type: "number",
                  },
                ]}
              />
              <Button size="sm" variant="secondary" onClick={() => openReceipt(p.id)}>
                {t("receiveStock")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setHistoryFor(p.id);
                  setHistoryPage(0);
                }}
              >
                {t("receiptHistory")}
              </Button>
            </div>
            <div className="mt-3 border-t pt-3">
              <Label htmlFor={`limit-${p.id}`}>{t("stockThreshold")}</Label>
              <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <Input
                  id={`limit-${p.id}`}
                  type="number"
                  min={0}
                  step={1}
                  value={limits[p.id] ?? String(p.low_stock_threshold)}
                  onChange={(e) => setLimits({ ...limits, [p.id]: e.target.value })}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={savingLimit === p.id}
                  onClick={() => saveLimit(p.id, p.low_stock_threshold)}
                >
                  {t("save")}
                </Button>
              </div>
              {p.low_stock_threshold === 0 && (
                <p className="mt-1 text-xs text-muted-foreground">{t("thresholdUnset")}</p>
              )}
            </div>
          </div>
        ))}
        {visibleProducts.length === 0 && <p className="text-muted-foreground">{t("noData")}</p>}
      </div>
      <Dialog open={!!receiptFor} onOpenChange={(o) => !o && setReceiptFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("receiveStock")} · {selectedProduct?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>{t("supplier")}</Label>
              <Input
                value={receiptForm.supplier}
                onChange={(e) => setReceiptForm({ ...receiptForm, supplier: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("purchaseReference")}</Label>
              <Input
                required
                value={receiptForm.purchaseReference}
                onChange={(e) =>
                  setReceiptForm({ ...receiptForm, purchaseReference: e.target.value })
                }
              />
            </div>
            <div className="space-y-1">
              <Label>{t("batchReference")}</Label>
              <Input
                value={receiptForm.batchReference}
                onChange={(e) => setReceiptForm({ ...receiptForm, batchReference: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("unitCost")}</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={receiptForm.unitCost}
                onChange={(e) => setReceiptForm({ ...receiptForm, unitCost: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("receivedOn")}</Label>
              <Input
                type="date"
                value={receiptForm.receivedOn}
                onChange={(e) => setReceiptForm({ ...receiptForm, receivedOn: e.target.value })}
              />
            </div>
            {selectedProduct && !selectedProduct.is_smartphone && (
              <div className="space-y-1">
                <Label>{t("quantity")}</Label>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={receiptForm.quantity}
                  onChange={(e) => setReceiptForm({ ...receiptForm, quantity: e.target.value })}
                />
              </div>
            )}
            <div className="space-y-1 sm:col-span-2">
              <Label>{t("note")}</Label>
              <Input
                value={receiptForm.note}
                onChange={(e) => setReceiptForm({ ...receiptForm, note: e.target.value })}
              />
            </div>
            {selectedProduct?.is_smartphone && (
              <div className="space-y-1 sm:col-span-2">
                <Label>{t("imeiList")}</Label>
                <Textarea rows={6} value={imeiText} onChange={(e) => setImeiText(e.target.value)} />
              </div>
            )}
          </div>
          <Button onClick={() => void saveReceipt()}>{t("receiveStock")}</Button>
        </DialogContent>
      </Dialog>
      <Dialog open={!!historyFor} onOpenChange={(open) => !open && setHistoryFor(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t("receiptHistory")} · {historyProduct?.name}
            </DialogTitle>
          </DialogHeader>
          {historyLoading && <p>{t("loading")}</p>}
          {historyError && <p className="text-destructive">{t("loadFailed")}</p>}
          {receiptCreatorsError && <p className="text-destructive">{t("loadFailed")}</p>}
          {!historyLoading && !receiptHistory.length && (
            <p className="text-sm text-muted-foreground">{t("noReceipts")}</p>
          )}
          <div className="divide-y">
            {receiptHistory.map((receipt) => (
              <div key={receipt.id} className="space-y-1 py-3 text-sm">
                <p className="font-semibold">
                  {receipt.supplier} · {receipt.received_on}
                </p>
                <p>
                  {t("quantityReceived")}: {receipt.quantity_received} · {t("quantityRemaining")}:{" "}
                  {receipt.quantity_remaining}
                </p>
                <p>
                  {t("unitCost")}:{" "}
                  {receipt.unit_cost === null ? t("unknownCost") : money(receipt.unit_cost)}
                </p>
                {(receipt.purchase_reference || receipt.batch_reference) && (
                  <p>
                    {receipt.purchase_reference ?? ""} · {receipt.batch_reference ?? ""}
                  </p>
                )}
                {receipt.note && <p>{receipt.note}</p>}
                <p className="break-all text-xs text-muted-foreground">
                  {t("receivedBy")}:{" "}
                  {receiptCreators.find((creator) => creator.id === receipt.created_by)
                    ?.full_name ||
                    receipt.created_by ||
                    "—"}{" "}
                  · {receipt.id}
                </p>
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={historyPage === 0}
              onClick={() => setHistoryPage(historyPage - 1)}
            >
              ←
            </Button>
            <span className="self-center text-sm">{historyPage + 1}</span>
            <Button
              variant="outline"
              disabled={receiptHistory.length < 50}
              onClick={() => setHistoryPage(historyPage + 1)}
            >
              →
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
