import { pageHead } from "@/lib/page-head";
import { createFileRoute } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileSpreadsheet, Printer } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type LedgerEntry = {
  id: string;
  entry_type: "sale" | "payment";
  created_at: string;
  total: number | null;
  paid: number | null;
  amount: number | null;
  note: string | null;
};
type LedgerPage = {
  totalCount: number;
  salesTotal: number;
  salePaid: number;
  collected: number;
  entries: LedgerEntry[];
};
type SaleRow = { id: string; created_at: string; total: number; paid: number; retailer_id: string };
type PayRow = {
  id: string;
  created_at: string;
  amount: number;
  note: string | null;
  retailer_id: string;
};
type RetailerRow = { id: string; name: string; phone: string | null; address: string | null };
type RetailerBalance = { sales_total: number; sale_paid: number; collected: number };
const LEDGER_PAGE_SIZE = 25;

function parseRetailerBalances(value: Json, invalidMessage: string): Map<string, RetailerBalance> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(invalidMessage);
  }
  const entries: [string, RetailerBalance][] = [];
  for (const [retailerId, row] of Object.entries(value)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(invalidMessage);
    }
    const readAmount = (key: keyof RetailerBalance) => {
      const amount = row[key];
      if (typeof amount !== "number" && typeof amount !== "string") {
        throw new Error(invalidMessage);
      }
      const parsed = Number(amount);
      if (!Number.isFinite(parsed)) throw new Error(invalidMessage);
      return parsed;
    };
    entries.push([
      retailerId,
      {
        sales_total: readAmount("sales_total"),
        sale_paid: readAmount("sale_paid"),
        collected: readAmount("collected"),
      },
    ]);
  }
  return new Map(entries);
}

export const Route = createFileRoute("/_authenticated/retailers")({
  head: () =>
    pageHead(
      "রিটেইলার লেজার",
      "FIROZA ENTERPRISE retailer ledgers, collections and outstanding balances.",
    ),
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
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const [printDoc, setPrintDoc] = useState<ReactNode | null>(null);
  const { data: balances = new Map<string, RetailerBalance>(), error: balanceError } = useQuery({
    queryKey: ["retailer-balances"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("retailer_balance_summary");
      if (error) throw error;
      return parseRetailerBalances(data, t("loadFailed"));
    },
  });
  const totalOf = (r: RetailerRow) => Number(balances.get(r.id)?.sales_total ?? 0);
  const paidOf = (r: RetailerRow) =>
    Number(balances.get(r.id)?.sale_paid ?? 0) + Number(balances.get(r.id)?.collected ?? 0);
  const ledgerQuery = useQuery({
    enabled: !!open,
    queryKey: ["retailer-ledger-page", open, from, to, page],
    queryFn: async (): Promise<LedgerPage> => {
      if (!open) throw new Error("Select a retailer first");
      const { data, error } = await supabase.rpc("retailer_ledger_page", {
        _retailer: open,
        _from: from || null,
        _to: to || null,
        _limit: LEDGER_PAGE_SIZE,
        _offset: page * LEDGER_PAGE_SIZE,
      });
      if (error) throw error;
      return data as LedgerPage;
    },
  });
  const appName = t("appName");

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!me) return;
    if (me.isAdmin && !salesmanId) {
      toast.error(t("selectSalesman"));
      return;
    }
    const result = await runOrQueue(
      { kind: "add_retailer", payload: { ...f, salesman_id: me.isAdmin ? salesmanId : me.id } },
      !online,
    );
    if (result.s === "error") {
      toast.error(result.error);
      return;
    }
    if (result.s === "queued") toast.success(t("savedOffline"));
    setF({ name: "", phone: "", address: "" });
    qc.invalidateQueries({ queryKey: ["retailers"] });
  }

  function exportAll() {
    const rows: (string | number)[][] = [
      [t("name"), t("phone"), t("address"), t("total"), t("paid"), t("due")],
    ];
    for (const r of retailers)
      rows.push([
        r.name,
        r.phone ?? "",
        r.address ?? "",
        totalOf(r),
        paidOf(r),
        totalOf(r) - paidOf(r),
      ]);
    exportCsv("retailer-ledger.csv", rows, t("retailers"));
  }

  async function loadAllLedgerEntries(r: RetailerRow) {
    const entries: LedgerEntry[] = [];
    let totalCount = 0;
    let totals: LedgerPage | undefined;
    do {
      const { data, error } = await supabase.rpc("retailer_ledger_page", {
        _retailer: r.id,
        _from: from || null,
        _to: to || null,
        _limit: 100,
        _offset: entries.length,
      });
      if (error) throw error;
      const result = data as LedgerPage;
      totalCount = result.totalCount;
      totals = result;
      entries.push(...result.entries);
    } while (entries.length < totalCount);
    if (!totals) throw new Error(t("loadFailed"));
    return { entries, totals };
  }

  async function exportOne(r: RetailerRow) {
    const { entries, totals } = await loadAllLedgerEntries(r);
    const rows: (string | number)[][] = [[t("date"), t("items"), t("sales"), t("paid")]];
    for (const e of entries) {
      if (e.entry_type === "sale")
        rows.push([
          new Date(e.created_at).toLocaleString(),
          t("sales"),
          Number(e.total),
          Number(e.paid),
        ]);
      else
        rows.push([
          new Date(e.created_at).toLocaleString(),
          `${t("collectPayment")}${e.note ? ` — ${e.note}` : ""}`,
          "",
          Number(e.amount),
        ]);
    }
    const salesTotal = totals?.salesTotal ?? totalOf(r);
    const paidTotal = (totals?.salePaid ?? 0) + (totals?.collected ?? 0);
    rows.push(
      [],
      [t("total"), "", salesTotal, paidTotal],
      [t("due"), "", "", salesTotal - paidTotal],
    );
    exportCsv(`ledger-${r.name}.csv`, rows, r.name);
  }

  async function printLedger(r: RetailerRow) {
    const { entries: rows, totals } = await loadAllLedgerEntries(r);
    const entries = rows.map((entry) =>
      entry.entry_type === "sale"
        ? {
            date: entry.created_at,
            label: `${t("sales")} (${t("paid")} ${money(entry.paid)})`,
            debit: Number(entry.total),
            credit: Number(entry.paid),
          }
        : {
            date: entry.created_at,
            label: `${t("collectPayment")}${entry.note ? ` — ${entry.note}` : ""}`,
            debit: 0,
            credit: Number(entry.amount),
          },
    );
    const salesTotal = totals?.salesTotal ?? totalOf(r);
    const paidTotal = (totals?.salePaid ?? 0) + (totals?.collected ?? 0);
    setPrintDoc(
      <LedgerDoc
        b={business}
        appName={appName}
        retailerName={r.name}
        retailerMeta={[r.phone, r.address].filter(Boolean).join(" · ") || undefined}
        entries={entries}
        total={salesTotal}
        paid={paidTotal}
      />,
    );
  }

  async function printSaleReceipt(s: SaleRow, r: RetailerRow) {
    const items = await fetchSaleItems(s.id);
    setPrintDoc(
      <SaleReceiptDoc
        b={business}
        appName={appName}
        saleId={s.id}
        date={s.created_at}
        retailerName={r.name}
        retailerMeta={r.phone ?? undefined}
        items={items}
        total={Number(s.total)}
        paid={Number(s.paid)}
      />,
    );
  }

  function printPayReceipt(p: PayRow, r: RetailerRow) {
    setPrintDoc(
      <MoneyReceiptDoc
        b={business}
        appName={appName}
        receiptId={p.id}
        date={p.created_at}
        fromName={r.name}
        fromMeta={r.phone ?? undefined}
        amount={Number(p.amount)}
        note={p.note}
        receivedBy={me?.profile?.full_name || ""}
      />,
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageTitle>
          {t("retailers")} · {t("ledger")}
        </PageTitle>
        <Button size="sm" variant="secondary" onClick={exportAll} disabled={!retailers.length}>
          <FileSpreadsheet className="mr-1 h-4 w-4" />
          {t("export")}
        </Button>
      </div>
      {balanceError && (
        <p role="alert" className="text-sm text-destructive">
          {t("loadFailed")}
        </p>
      )}
      {me && (me.isAdmin || me.permissions.retailer_manage) && (
        <form onSubmit={add} className="grid gap-3 rounded-xl border bg-card p-4 md:grid-cols-4">
          {me.isAdmin && (
            <Select value={salesmanId} onValueChange={setSalesmanId}>
              <SelectTrigger>
                <SelectValue placeholder={t("selectSalesman")} />
              </SelectTrigger>
              <SelectContent>
                {salesmen.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Input
            required
            placeholder={t("name")}
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
          <Input
            placeholder={t("phone")}
            value={f.phone}
            onChange={(e) => setF({ ...f, phone: e.target.value })}
          />
          <Input
            placeholder={t("address")}
            value={f.address}
            onChange={(e) => setF({ ...f, address: e.target.value })}
          />
          <Button>{t("add")}</Button>
        </form>
      )}
      <div className="space-y-3">
        {retailers.map((r) => {
          const total = totalOf(r);
          const paid = paidOf(r);
          const entries = open === r.id ? (ledgerQuery.data?.entries ?? []) : [];
          return (
            <div key={r.id} className="rounded-xl border bg-card p-4">
              <button
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-left sm:flex sm:flex-wrap sm:gap-3"
                onClick={() => {
                  setOpen(open === r.id ? null : r.id);
                  setPage(0);
                }}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-display font-bold">{r.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {r.phone} {r.address}
                  </div>
                </div>
                <span className="text-sm">
                  {t("total")}: {money(total)}
                </span>
                <span className="text-sm text-success">
                  {t("paid")}: {money(paid)}
                </span>
                <span className="font-bold text-destructive">
                  {t("due")}: {money(total - paid)}
                </span>
              </button>
              {open === r.id && (
                <div className="mt-3 space-y-3 border-t pt-3">
                  {!me?.isAdmin && me?.permissions.collect_payment && (
                    <PaymentForm retailerId={r.id} max={total - paid} />
                  )}
                  <div className="flex flex-wrap gap-2">
                    {(me?.isAdmin || me?.permissions.retailer_manage) && (
                      <RecordActions
                        table="retailers"
                        id={r.id}
                        fields={[
                          { key: "name", label: "name", value: r.name },
                          { key: "phone", label: "phone", value: r.phone },
                          { key: "address", label: "address", value: r.address },
                        ]}
                      />
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        void exportOne(r).catch((error) => toast.error((error as Error).message))
                      }
                    >
                      <FileSpreadsheet className="mr-1 h-4 w-4" />
                      {t("export")}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        void printLedger(r).catch((error) => toast.error((error as Error).message))
                      }
                    >
                      <Printer className="mr-1 h-4 w-4" />
                      {t("print")}
                    </Button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <div className="space-y-1">
                      <label
                        htmlFor={`ledger-from-${r.id}`}
                        className="text-xs text-muted-foreground"
                      >
                        {t("dateFrom")}
                      </label>
                      <Input
                        id={`ledger-from-${r.id}`}
                        type="date"
                        value={from}
                        onChange={(e) => {
                          setFrom(e.target.value);
                          setPage(0);
                        }}
                      />
                    </div>
                    <div className="space-y-1">
                      <label
                        htmlFor={`ledger-to-${r.id}`}
                        className="text-xs text-muted-foreground"
                      >
                        {t("dateTo")}
                      </label>
                      <Input
                        id={`ledger-to-${r.id}`}
                        type="date"
                        value={to}
                        onChange={(e) => {
                          setTo(e.target.value);
                          setPage(0);
                        }}
                      />
                    </div>
                    <Button
                      type="button"
                      className="self-end"
                      variant="outline"
                      onClick={() => {
                        setFrom("");
                        setTo("");
                        setPage(0);
                      }}
                    >
                      {t("clear")}
                    </Button>
                  </div>
                  {ledgerQuery.isError && (
                    <p role="alert" className="text-sm text-destructive">
                      {t("loadFailed")}
                    </p>
                  )}
                  {ledgerQuery.isPending && (
                    <p role="status" className="text-sm text-muted-foreground">
                      {t("loading")}
                    </p>
                  )}
                  <div className="space-y-1 text-sm">
                    {entries.map((entry) => (
                      <div
                        key={entry.entry_type + entry.id}
                        className="flex items-center justify-between gap-2 rounded bg-muted px-2 py-1"
                      >
                        {entry.entry_type === "sale" ? (
                          <>
                            <span className="min-w-0 flex-1 truncate">
                              {t("sales")} {money(entry.total)} · {t("paid")} {money(entry.paid)}
                            </span>
                            <span className="shrink-0 text-muted-foreground">
                              {new Date(entry.created_at).toLocaleDateString()}
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 shrink-0 px-2"
                              onClick={() =>
                                printSaleReceipt(
                                  {
                                    id: entry.id,
                                    created_at: entry.created_at,
                                    total: Number(entry.total),
                                    paid: Number(entry.paid),
                                    retailer_id: r.id,
                                  },
                                  r,
                                )
                              }
                              title={t("printReceipt")}
                            >
                              <Printer className="h-4 w-4" />
                            </Button>
                          </>
                        ) : (
                          <>
                            <span className="min-w-0 flex-1 truncate">
                              {t("collectPayment")} {money(entry.amount)}
                              {entry.note ? ` — ${entry.note}` : ""}
                            </span>
                            <span className="shrink-0 text-muted-foreground">
                              {new Date(entry.created_at).toLocaleDateString()}
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 shrink-0 px-2"
                              onClick={() =>
                                printPayReceipt(
                                  {
                                    id: entry.id,
                                    created_at: entry.created_at,
                                    amount: Number(entry.amount),
                                    note: entry.note,
                                    retailer_id: r.id,
                                  },
                                  r,
                                )
                              }
                              title={t("printReceipt")}
                            >
                              <Printer className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    ))}
                    {!ledgerQuery.isPending && entries.length === 0 && (
                      <p className="py-2 text-muted-foreground">{t("noData")}</p>
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
                      <span className="text-center text-muted-foreground">
                        {ledgerQuery.data.totalCount === 0 ? 0 : page * LEDGER_PAGE_SIZE + 1}–
                        {Math.min((page + 1) * LEDGER_PAGE_SIZE, ledgerQuery.data.totalCount)} /{" "}
                        {ledgerQuery.data.totalCount}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={(page + 1) * LEDGER_PAGE_SIZE >= ledgerQuery.data.totalCount}
                        onClick={() => setPage(page + 1)}
                      >
                        {t("nextPage")}
                      </Button>
                    </div>
                  )}
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
    if (n <= 0 || n > max) {
      toast.error(`${t("due")}: ${money(max)}`);
      return;
    }
    const result = await runOrQueue(
      { kind: "retailer_payment", payload: { retailer_id: retailerId, amount: n } },
      !online,
    );
    if (result.s === "error") {
      toast.error(result.error);
      return;
    }
    setAmt("");
    toast.success(t(result.s === "queued" ? "savedOffline" : "done"));
    qc.invalidateQueries();
  }
  return (
    <form onSubmit={pay} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
      <Input
        type="number"
        placeholder={t("amount")}
        value={amt}
        onChange={(e) => setAmt(e.target.value)}
      />
      <Button>{t("collectPayment")}</Button>
    </form>
  );
}
