import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Download, Upload, RefreshCw, ShieldAlert, Database } from "lucide-react";
import { toast } from "sonner";
import { pageHead } from "@/lib/page-head";
import { useMe } from "@/lib/me";
import { useT, type Key } from "@/lib/i18n";
import { useBusiness } from "@/lib/business";
import { assignLegacyQueueToUser, getLegacyQueueCount, getQueue, replayQueue, useOnline, usePendingSyncCount } from "@/lib/offline";
import { CACHE_KEY } from "@/lib/query-persist";
import { supabase } from "@/integrations/supabase/client";
import { exportBusinessData, resetBusinessData, restoreBusinessData } from "@/lib/settings.functions";
import { parseBusinessBackup, backupCounts, RESET_PHRASE, RESTORE_PHRASE, type BusinessBackup } from "@/lib/settings-data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageTitle } from "@/components/Stat";
import { RecordActions } from "@/components/RecordActions";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => pageHead("সেটিংস", "FIROZA ENTERPRISE account settings, business data backups, restoration and audited account corrections."),
  component: Settings,
});

function Settings() {
  const { t, lang, setLang } = useT();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const online = useOnline();
  const pending = usePendingSyncCount();
  const [business, saveBusiness] = useBusiness();
  const [company, setCompany] = useState(business);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [backupId, setBackupId] = useState<string | null>(null);
  const [backup, setBackup] = useState<BusinessBackup | null>(null);
  const [mode, setMode] = useState<"reset" | "restore" | "cache" | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [legacyQueueCount, setLegacyQueueCount] = useState(0);
  const exportData = useServerFn(exportBusinessData);
  const reset = useServerFn(resetBusinessData);
  const restore = useServerFn(restoreBusinessData);
  const blocked = !online || pending > 0 || busy;
  useEffect(() => setLegacyQueueCount(getLegacyQueueCount()), [pending]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); try { await action(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function download() {
    if (getQueue().length) throw new Error(t("queueGuard"));
    const snapshot = parseBusinessBackup(await exportData());
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `firoza-business-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    setBackupId(snapshot.source); toast.success(t("downloadComplete"));
  }
  function open(value: "reset" | "restore" | "cache") { setMode(value); setConfirmation(""); }
  async function confirm() {
    if (getQueue().length) throw new Error(t("queueGuard"));
    if (mode === "cache") {
      await qc.cancelQueries(); qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
      localStorage.removeItem(CACHE_KEY); setMode(null); toast.success(t("done")); return;
    }
    if (!backupId) throw new Error(t("safetyBackup"));
    if (mode === "reset" && confirmation === RESET_PHRASE) await reset({ data: { confirmation: RESET_PHRASE, backupId } });
    else if (mode === "restore" && backup && confirmation === RESTORE_PHRASE) await restore({ data: { confirmation: RESTORE_PHRASE, backup, backupId } });
    else return;
    await qc.cancelQueries(); qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    localStorage.removeItem(CACHE_KEY); setBackupId(null); setBackup(null); setMode(null);
    await qc.invalidateQueries(); toast.success(t("done"));
  }
  return <div className="space-y-8">
    <PageTitle>{t("settings")}</PageTitle>
    <section className="space-y-4 border-b pb-6">
      <h2 className="font-display text-lg font-bold">{t("account")}</h2>
      <p className="break-all text-sm text-muted-foreground">{me?.profile?.full_name} · {me?.email}</p>
      <div className="max-w-sm space-y-1"><Label>{t("language")}</Label><Select value={lang} onValueChange={(v) => setLang(v === "en" ? "en" : "bn")}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="bn">বাংলা</SelectItem><SelectItem value="en">English</SelectItem></SelectContent></Select></div>
      <form className="grid max-w-xl gap-2 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={(e) => { e.preventDefault(); void run(async () => { const { error } = await supabase.auth.updateUser({ password }); if (error) throw error; setPassword(""); toast.success(t("done")); }); }}>
        <Input aria-label={t("password")} placeholder={t("password")} type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} /><Button disabled={!online || busy}>{t("changePassword")}</Button>
      </form>
    </section>
    <section className="space-y-4 border-b pb-6"><h2 className="font-display text-lg font-bold">{t("businessInfo")}</h2>
      <form onSubmit={(e) => { e.preventDefault(); saveBusiness(company); toast.success(t("done")); }} className="grid gap-3 sm:grid-cols-2">
        {(["name", "address", "phone"] as const).map((k) => <div key={k} className="space-y-1"><Label htmlFor={`company-${k}`}>{t(k)}</Label><Input id={`company-${k}`} value={company[k]} onChange={(e) => setCompany({ ...company, [k]: e.target.value })} /></div>)}
        <Button className="self-end">{t("save")}</Button>
      </form>
    </section>
    <section className="space-y-3 border-b pb-6"><h2 className="font-display text-lg font-bold">{t("localData")}</h2>
      <p className="text-sm text-muted-foreground">{online ? t("online") : t("offline")} · {pending} {t("pendingSync")}</p>
      {legacyQueueCount > 0 && <div className="space-y-2 rounded-lg border border-warning p-3 text-sm">
        <p>{t("legacyQueueWarning")} · {legacyQueueCount}</p>
        <Button variant="outline" disabled={!me?.id || busy} onClick={() => {
          if (!me?.id || !window.confirm(t("legacyQueueConfirm"))) return;
          const count = assignLegacyQueueToUser(me.id);
          setLegacyQueueCount(0);
          toast.success(`${count} ${t("pendingSync")}`);
        }}>{t("claimLegacyQueue")}</Button>
      </div>}
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!online || busy || !pending} onClick={() => void run(async () => { const result = await replayQueue(); if (result.failed) throw new Error(result.failed); await qc.invalidateQueries(); toast.success(t("syncDone")); })}><RefreshCw className="mr-2 h-4 w-4" />{t("syncNow")}</Button><Button variant="outline" disabled={pending > 0 || busy} onClick={() => open("cache")}>{t("clearCache")}</Button></div>
      {pending > 0 && <p className="text-sm text-destructive">{t("queueGuard")}</p>}
    </section>
    {me?.isAdmin && <>
      <section className="space-y-4 border-b pb-6"><h2 className="flex items-center gap-2 font-display text-lg font-bold"><Database className="h-5 w-5" />{t("backup")}</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">{t("backupScope")}</p>
        <Button disabled={blocked} onClick={() => void run(download)}><Download className="mr-2 h-4 w-4" />{t("downloadBackup")}</Button>
        <div className="space-y-2"><Label htmlFor="backup-file">{t("chooseFile")}</Label><Input id="backup-file" className="max-w-xl" type="file" accept="application/json,.json" disabled={blocked} onChange={(e) => { const file = e.target.files?.[0]; setBackup(null); if (!file) return; if (file.size > 20 * 1024 * 1024) { toast.error("20 MB maximum"); return; } void run(async () => { setBackup(parseBusinessBackup(await file.text())); }); }} /></div>
        {backup && <div className="space-y-3"><p className="text-sm">{new Date(backup.exported_at).toLocaleString()}</p><div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">{backupCounts(backup).map(({ table, count }) => <div key={table} className="border-b py-1">{t(tableLabel[table] ?? "history")}: <b>{count}</b></div>)}</div><p className="text-sm text-muted-foreground">{t("restoreScope")}</p><Button variant="outline" disabled={blocked || !backupId} onClick={() => open("restore")}><Upload className="mr-2 h-4 w-4" />{t("restore")}</Button></div>}
        {!backupId && <p className="text-sm text-muted-foreground">{t("safetyBackup")}</p>}
      </section>
      <AccountCorrections />
      <section className="space-y-3 border-b pb-6"><h2 className="font-display text-lg font-bold">{t("fullBackup")}</h2><p className="text-sm text-muted-foreground">{t("cloudBackupSteps")}</p><p className="text-sm text-muted-foreground">{t("cloudRestoreSteps")}</p></section>
      <section className="space-y-3"><h2 className="flex items-center gap-2 font-display text-lg font-bold text-destructive"><ShieldAlert className="h-5 w-5" />{t("resetAll")}</h2><p className="max-w-3xl text-sm">{t("resetWarning")}</p><Button variant="destructive" disabled={blocked || !backupId} onClick={() => open("reset")}>{t("resetAll")}</Button></section>
    </>}
    <Dialog open={mode !== null} onOpenChange={(o) => { if (!busy && !o) setMode(null); }}><DialogContent><DialogHeader><DialogTitle>{t(mode === "reset" ? "resetAll" : mode === "restore" ? "restore" : "clearCache")}</DialogTitle></DialogHeader>
      <p className="text-sm">{t(mode === "reset" ? "resetWarning" : mode === "restore" ? "restoreScope" : "localData")}</p>
      {mode !== "cache" && <div className="space-y-1"><Label htmlFor="confirmation">{t("confirmText")}: <b>{mode === "reset" ? RESET_PHRASE : RESTORE_PHRASE}</b></Label><Input id="confirmation" autoComplete="off" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></div>}
      <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => setMode(null)}>{t("cancel")}</Button><Button variant="destructive" disabled={busy || (mode !== "cache" && confirmation !== (mode === "reset" ? RESET_PHRASE : RESTORE_PHRASE))} onClick={() => void run(confirm)}>{t("confirm")}</Button></div>
    </DialogContent></Dialog>
  </div>;
}
const tableLabel: Record<string, Key> = { products: "products", retailers: "retailers", imei_units: "imeiList", sales: "sales", stock_movements: "history", retailer_payments: "collectPayment", deposits: "deposited", dealer_blocks: "blocked", dealer_risk_assessments: "paymentRisk" };
function AccountCorrections() {
  const { t } = useT();
  const [table, setTable] = useState<"sales" | "stock_movements" | "retailer_payments" | "deposits" | "imei_units">("retailer_payments");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const { data = [], isLoading, error } = useQuery({ queryKey: ["settings-records", table, page], queryFn: async () => { const { data, error } = await supabase.from(table).select("*").order("created_at", { ascending: false }).range(page * 50, page * 50 + 49); if (error) throw error; return data; } });
  const { data: audit = [] } = useQuery({ queryKey: ["settings-audit"], queryFn: async () => { const { data, error } = await supabase.from("business_audit").select("id,action,entity,reason,created_at").order("created_at", { ascending: false }).limit(20); if (error) throw error; return data; } });
  return <section className="space-y-4 border-b pb-6"><h2 className="font-display text-lg font-bold">{t("transactionControls")}</h2><p className="text-sm text-muted-foreground">{t("transactionSafety")}</p>
    <div className="grid gap-2 sm:grid-cols-2"><Select value={table} onValueChange={(v) => { if (v === "sales" || v === "stock_movements" || v === "retailer_payments" || v === "deposits" || v === "imei_units") { setTable(v); setPage(0); } }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["sales", "stock_movements", "retailer_payments", "deposits", "imei_units"].map((v) => <SelectItem key={v} value={v}>{t(tableLabel[v] ?? "history")}</SelectItem>)}</SelectContent></Select><Input aria-label={t("name")} placeholder={t("name")} value={search} onChange={(e) => setSearch(e.target.value)} /></div>
    {isLoading && <p>{t("loading")}</p>}{error && <p className="text-destructive">{t("loadFailed")}</p>}
    <div className="divide-y">{data.filter((row) => JSON.stringify(row).toLowerCase().includes(search.toLowerCase())).map((row) => {
      const r = row as { id: string; created_at: string; amount?: number; note?: string | null; total?: number; imei?: string; kind?: string; qty?: number };
      const fields = table === "retailer_payments" || table === "deposits" ? [{ key: "amount", label: "amount" as const, value: r.amount ?? 0, type: "number" as const }, { key: "note", label: "note" as const, value: r.note ?? "" }] : [];
      return <div key={r.id} className="flex items-center justify-between gap-2 py-3"><div className="min-w-0"><p className="break-all text-sm font-semibold">{r.imei ?? r.amount ?? r.total ?? `${r.kind} · ${r.qty}`}</p><p className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</p><p className="break-all text-xs text-muted-foreground">{r.id}</p></div><RecordActions table={table} id={r.id} fields={fields} /></div>;
    })}</div>
    <div className="flex justify-end gap-2"><Button variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>←</Button><span className="self-center text-sm">{page + 1}</span><Button variant="outline" disabled={data.length < 50} onClick={() => setPage(page + 1)}>→</Button></div>
    <h3 className="font-semibold">{t("auditLog")}</h3><div className="max-h-60 overflow-auto divide-y text-sm">{audit.map((a) => <div key={a.id} className="py-2"><span>{a.action} · {a.entity ? t(tableLabel[a.entity] ?? "salesmen") : t("settings")}</span><p className="break-words text-muted-foreground">{a.reason} · {new Date(a.created_at).toLocaleString()}</p></div>)}</div>
  </section>;
}