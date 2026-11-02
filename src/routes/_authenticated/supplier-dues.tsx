import { pageHead } from "@/lib/page-head";
import { createFileRoute } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileSpreadsheet, Printer } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { requireAdmin, useMe } from "@/lib/me";
import { useBusiness } from "@/lib/business";
import { useT } from "@/lib/i18n";
import { money } from "@/lib/imei";
import { exportCsv } from "@/lib/export";
import { runOrQueue, useOnline } from "@/lib/offline";
import { PaymentVoucherDoc, PrintSheet } from "@/components/PrintDocs";
import { RecordActions } from "@/components/RecordActions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageTitle } from "@/components/Stat";
import { z } from "zod";

const amountValue = z.union([z.number(), z.string()]).transform(Number).refine(Number.isFinite);
const supplierBalanceSchema = z.object({
  supplier: z.string(),
  purchase_total: amountValue,
  paid_total: amountValue,
  due: amountValue,
  period_purchases: amountValue,
  period_paid: amountValue,
  receipt_count: amountValue,
  payment_count: amountValue,
});
const supplierEntrySchema = z.object({
  id: z.string().uuid(),
  entry_type: z.enum(["receipt", "payment"]),
  created_at: z.string(),
  supplier: z.string(),
  reference: z.string().nullable(),
  product_id: z.string().uuid().nullable(),
  product_name: z.string().nullable(),
  quantity: amountValue.nullable(),
  unit_cost: amountValue.nullable(),
  amount: amountValue,
  note: z.string().nullable(),
});
const supplierLedgerPageSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  entries: z.array(supplierEntrySchema),
});
type SupplierBalance = z.infer<typeof supplierBalanceSchema>;
type SupplierEntry = z.infer<typeof supplierEntrySchema>;
type SupplierLedgerPage = z.infer<typeof supplierLedgerPageSchema>;
const PAGE_SIZE = 25;

export const Route = createFileRoute("/_authenticated/supplier-dues")({
  beforeLoad: requireAdmin,
  head: () =>
    pageHead("সাপ্লায়ার বাকি", "FIROZA ENTERPRISE supplier payment and purchase due ledgers."),
  component: SupplierDues,
});

function SupplierDues() {
  const { t } = useT();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const online = useOnline();
  const [business] = useBusiness();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [dueOnly, setDueOnly] = useState(false);
  const [supplier, setSupplier] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [printDoc, setPrintDoc] = useState<ReactNode | null>(null);
  const appName = t("appName");

  const balancesQuery = useQuery({
    queryKey: ["supplier-due-summary", from, to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("supplier_due_summary", {
        _from: from || null,
        _to: to || null,
      });
      if (error) throw error;
      return supplierBalanceSchema.array().parse(data);
    },
  });
  const ledgerQuery = useQuery({
    enabled: !!supplier,
    queryKey: ["supplier-ledger-page", supplier, from, to, page],
    queryFn: async (): Promise<SupplierLedgerPage> => {
      if (!supplier) throw new Error("Select a supplier first");
      const { data, error } = await supabase.rpc("supplier_ledger_page", {
        _supplier: supplier,
        _from: from || null,
        _to: to || null,
        _limit: PAGE_SIZE,
        _offset: page * PAGE_SIZE,
      });
      if (error) throw error;
      return supplierLedgerPageSchema.parse(data);
    },
  });

  const filtered = (balancesQuery.data ?? []).filter((row) => {
    const matchesText = row.supplier
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase());
    return matchesText && (!dueOnly || Number(row.due) > 0);
  });
  const groupedTotals = filtered.reduce(
    (totals, row) => ({
      purchases: totals.purchases + row.purchase_total,
      paid: totals.paid + row.paid_total,
      due: totals.due + row.due,
      periodPurchases: totals.periodPurchases + row.period_purchases,
      periodPaid: totals.periodPaid + row.period_paid,
    }),
    { purchases: 0, paid: 0, due: 0, periodPurchases: 0, periodPaid: 0 },
  );

  async function loadAllEntries(name: string) {
    const entries: SupplierEntry[] = [];
    let totalCount = 0;
    do {
      const { data, error } = await supabase.rpc("supplier_ledger_page", {
        _supplier: name,
        _from: from || null,
        _to: to || null,
        _limit: 100,
        _offset: entries.length,
      });
      if (error) throw error;
      const result = supplierLedgerPageSchema.parse(data);
      totalCount = result.totalCount;
      entries.push(...result.entries);
    } while (entries.length < totalCount);
    return entries;
  }

  async function exportSupplier(name: string) {
    const entries = await loadAllEntries(name);
    const balance = balancesQuery.data?.find(
      (row) => row.supplier.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (!balance) throw new Error(t("loadFailed"));
    exportCsv(
      "supplier-ledger.csv",
      [
        [t("supplier"), name],
        [t("purchases"), balance.purchase_total],
        [t("paidToSupplier"), balance.paid_total],
        [t("supplierDue"), balance.due],
        [t("periodPurchases"), balance.period_purchases],
        [t("periodPayments"), balance.period_paid],
        [],
        [t("date"), t("items"), t("purchaseReference"), t("amount"), t("note")],
        ...entries.map((entry) => [
          new Date(entry.created_at).toLocaleString(),
          entry.entry_type === "receipt"
            ? (entry.product_name ?? t("purchases"))
            : t("paidToSupplier"),
          entry.reference ?? "",
          entry.entry_type === "receipt" ? Number(entry.amount) : -Number(entry.amount),
          entry.note ?? "",
        ]),
      ],
      name,
    );
  }

  async function paySupplier(e: React.FormEvent, row: SupplierBalance) {
    e.preventDefault();
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0 || value > Number(row.due)) {
      toast.error(`${t("paymentExceedsDue")}: ${money(row.due)}`);
      return;
    }
    const result = await runOrQueue(
      {
        kind: "supplier_payment",
        payload: { supplier: row.supplier, amount: value, note: note.trim() || null },
      },
      !online,
    );
    if (result.s === "error") {
      toast.error(result.error);
      return;
    }
    setAmount("");
    setNote("");
    toast.success(t(result.s === "queued" ? "savedOffline" : "done"));
    qc.invalidateQueries();
    if (result.s === "done") {
      const data = result.data as { id?: unknown } | null;
      if (typeof data?.id === "string") {
        setPrintDoc(
          <PaymentVoucherDoc
            b={business}
            appName={appName}
            paymentId={data.id}
            date={new Date().toISOString()}
            supplier={row.supplier}
            amount={value}
            note={note.trim() || null}
            paidBy={me?.profile?.full_name || t("businessOwner")}
          />,
        );
      }
    }
  }

  function printPayment(entry: SupplierEntry) {
    setPrintDoc(
      <PaymentVoucherDoc
        b={business}
        appName={appName}
        paymentId={entry.id}
        date={entry.created_at}
        supplier={entry.supplier}
        amount={Number(entry.amount)}
        note={entry.note}
        paidBy={me?.profile?.full_name || t("businessOwner")}
      />,
    );
  }

  if (!me?.isAdmin) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageTitle>{t("supplierDues")}</PageTitle>
        <Button
          size="sm"
          variant="secondary"
          disabled={!filtered.length}
          onClick={() =>
            exportCsv(
              "supplier-dues.csv",
              [
                [
                  t("supplier"),
                  t("purchases"),
                  t("paidToSupplier"),
                  t("supplierDue"),
                  t("periodPurchases"),
                  t("periodPayments"),
                ],
                ...filtered.map((row) => [
                  row.supplier,
                  Number(row.purchase_total),
                  Number(row.paid_total),
                  Number(row.due),
                  Number(row.period_purchases),
                  Number(row.period_paid),
                ]),
              ],
              t("supplierDues"),
            )
          }
        >
          <FileSpreadsheet className="mr-1 h-4 w-4" />
          {t("export")}
        </Button>
      </div>
      {balancesQuery.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("loadFailed")}
        </p>
      )}
      <div className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Input
          placeholder={t("searchSupplier")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={dueOnly} onChange={(e) => setDueOnly(e.target.checked)} />
          {t("dueOnly")}
        </label>
        <div className="space-y-1">
          <label htmlFor="supplier-from" className="text-xs text-muted-foreground">
            {t("dateFrom")}
          </label>
          <Input
            id="supplier-from"
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(0);
            }}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="supplier-to" className="text-xs text-muted-foreground">
            {t("dateTo")}
          </label>
          <Input
            id="supplier-to"
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(0);
            }}
          />
        </div>
      </div>
      <div className="grid gap-2 rounded-xl border bg-muted/40 p-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
        <span>
          {t("purchases")}: <b>{money(groupedTotals.purchases)}</b>
        </span>
        <span>
          {t("paidToSupplier")}: <b>{money(groupedTotals.paid)}</b>
        </span>
        <span>
          {t("supplierDue")}: <b>{money(groupedTotals.due)}</b>
        </span>
        <span>
          {t("periodPurchases")}: <b>{money(groupedTotals.periodPurchases)}</b>
        </span>
        <span>
          {t("periodPayments")}: <b>{money(groupedTotals.periodPaid)}</b>
        </span>
      </div>
      {balancesQuery.isPending && <p role="status">{t("loading")}</p>}
      {filtered.map((row) => (
        <section key={row.supplier.toLowerCase()} className="rounded-xl border bg-card p-4">
          <button
            type="button"
            className="grid w-full gap-2 text-left sm:grid-cols-2 lg:grid-cols-4"
            onClick={() => {
              setSupplier(supplier === row.supplier ? null : row.supplier);
              setPage(0);
            }}
          >
            <strong className="break-words">{row.supplier}</strong>
            <span>
              {t("purchases")}: {money(row.purchase_total)}
            </span>
            <span>
              {t("paidToSupplier")}: {money(row.paid_total)}
            </span>
            <span className="font-bold text-destructive">
              {t("supplierDue")}: {money(row.due)}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("periodPurchases")}: {money(row.period_purchases)}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("periodPayments")}: {money(row.period_paid)}
            </span>
          </button>
          {supplier === row.supplier && (
            <div className="mt-4 space-y-3 border-t pt-4">
              {Number(row.due) > 0 && (
                <form
                  onSubmit={(e) => void paySupplier(e, row)}
                  className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
                >
                  <Input
                    required
                    type="number"
                    min="0.01"
                    step="0.01"
                    max={row.due}
                    placeholder={t("amount")}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <Input
                    placeholder={t("note")}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <Button>{t("paySupplier")}</Button>
                </form>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void exportSupplier(row.supplier).catch((error) =>
                      toast.error((error as Error).message),
                    )
                  }
                >
                  <FileSpreadsheet className="mr-1 h-4 w-4" />
                  {t("export")}
                </Button>
              </div>
              {ledgerQuery.isError && (
                <p role="alert" className="text-sm text-destructive">
                  {t("loadFailed")}
                </p>
              )}
              {ledgerQuery.isPending && <p role="status">{t("loading")}</p>}
              <div className="space-y-2">
                {(ledgerQuery.data?.entries ?? []).map((entry) => (
                  <div
                    key={`${entry.entry_type}-${entry.id}`}
                    className="flex flex-wrap items-center gap-2 rounded bg-muted px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1">
                      {entry.entry_type === "receipt"
                        ? `${entry.product_name ?? t("purchases")} · ${entry.quantity} × ${money(entry.unit_cost)}`
                        : t("paidToSupplier")}
                      {entry.reference ? ` · ${entry.reference}` : ""}
                      {entry.note ? ` · ${entry.note}` : ""}
                    </span>
                    <span>
                      {entry.entry_type === "receipt" ? "+" : "−"}
                      {money(entry.amount)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(entry.created_at).toLocaleDateString()}
                    </span>
                    {entry.entry_type === "payment" && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          title={t("printReceipt")}
                          onClick={() => printPayment(entry)}
                        >
                          <Printer className="h-4 w-4" />
                        </Button>
                        <RecordActions
                          table="supplier_payments"
                          id={entry.id}
                          fields={[
                            {
                              key: "amount",
                              label: "amount",
                              value: Number(entry.amount),
                              type: "number",
                            },
                            { key: "note", label: "note", value: entry.note },
                          ]}
                        />
                      </>
                    )}
                  </div>
                ))}
                {!ledgerQuery.isPending && !ledgerQuery.data?.entries.length && (
                  <p className="text-sm text-muted-foreground">{t("noData")}</p>
                )}
              </div>
              {ledgerQuery.data && (
                <div className="flex items-center justify-between gap-2 border-t pt-2 text-sm">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    {t("previousPage")}
                  </Button>
                  <span>
                    {ledgerQuery.data.totalCount === 0 ? 0 : page * PAGE_SIZE + 1}–
                    {Math.min((page + 1) * PAGE_SIZE, ledgerQuery.data.totalCount)} /{" "}
                    {ledgerQuery.data.totalCount}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={(page + 1) * PAGE_SIZE >= ledgerQuery.data.totalCount}
                    onClick={() => setPage(page + 1)}
                  >
                    {t("nextPage")}
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>
      ))}
      {!balancesQuery.isPending && filtered.length === 0 && (
        <p className="text-muted-foreground">{t("noSupplierDue")}</p>
      )}
      {printDoc && <PrintSheet onDone={() => setPrintDoc(null)}>{printDoc}</PrintSheet>}
    </div>
  );
}
