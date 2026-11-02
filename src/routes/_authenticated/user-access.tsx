import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ShieldCheck, Search, Check, Minus } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { requireAdmin, useMe } from "@/lib/me";
import { useT, type Key } from "@/lib/i18n";
import { pageHead } from "@/lib/page-head";
import { ACTION_PERMISSIONS, DEFAULT_PERMISSIONS, type AccessPermissions } from "@/lib/access";
import { saveUserAccess } from "@/lib/access.functions";
import { useOnline } from "@/lib/offline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageTitle } from "@/components/Stat";
const permissionLabel: Record<string, Key> = { sales: "sales", returns: "returnGoods", retailer_manage: "retailers", collect_payment: "collectPayment" };
type UserRow = { id: string; full_name: string; phone: string | null; active: boolean; role: "admin" | "salesman"; permissions: AccessPermissions };
export const Route = createFileRoute("/_authenticated/user-access")({ beforeLoad: requireAdmin, head: () => pageHead("ব্যবহারকারী ও অনুমতি", "FIROZA ENTERPRISE owner-managed user roles, account access, action permissions and audit history."), component: UserAccess });
function UserAccess() {
  const { t } = useT(); const { data: me } = useMe(); const online = useOnline(); const qc = useQueryClient(); const save = useServerFn(saveUserAccess);
  const [search, setSearch] = useState(""); const [filter, setFilter] = useState("all"); const [edit, setEdit] = useState<UserRow | null>(null); const [reason, setReason] = useState(""); const [confirming, setConfirming] = useState(false); const [busy, setBusy] = useState(false);
  const { data: users = [], isLoading, error, refetch } = useQuery({ queryKey: ["user-access-list"], queryFn: async (): Promise<UserRow[]> => {
    const [profiles, roles, overrides] = await Promise.all([supabase.from("profiles").select("id,full_name,phone,active").order("full_name"), supabase.from("user_roles").select("user_id,role"), supabase.from("user_permission_overrides").select("user_id,permissions")]);
    for (const result of [profiles, roles, overrides]) if (result.error) throw result.error;
    return (profiles.data ?? []).map((p) => {
      const role = roles.data?.some((r) => r.user_id === p.id && r.role === "admin") ? "admin" as const : "salesman" as const;
      const permissions = { ...DEFAULT_PERMISSIONS }; const saved = overrides.data?.find((o) => o.user_id === p.id)?.permissions;
      if (saved && typeof saved === "object" && !Array.isArray(saved)) for (const k of ACTION_PERMISSIONS) if (typeof saved[k] === "boolean") permissions[k] = saved[k];
      return { ...p, role, permissions };
    });
  } });
  const { data: history = [] } = useQuery({ queryKey: ["user-access-history"], queryFn: async () => { const { data, error } = await supabase.from("business_audit").select("id,actor,entity_id,reason,created_at,after_data").eq("action", "access_change").order("created_at", { ascending: false }).limit(50); if (error) throw error; return data ?? []; } });
  async function submit() { if (!edit || busy) return; setBusy(true); try { await save({ data: { userId: edit.id, role: edit.role, active: edit.active, permissions: edit.permissions, reason, confirmed: true } }); await qc.invalidateQueries(); setEdit(null); setConfirming(false); toast.success(t("done")); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  return <div className="space-y-6"><div className="flex flex-wrap items-center justify-between gap-3"><PageTitle><ShieldCheck className="mr-2 inline h-6 w-6" />{t("userAccess")}</PageTitle><Button asChild variant="outline"><Link to="/salesmen">{t("newSalesman")}</Link></Button></div>
    <div className="grid grid-cols-3 gap-4 border-y py-4">{([["totalUsers", users.length], ["ownerRole", users.filter((u) => u.role === "admin").length], ["active", users.filter((u) => u.active).length]] as [Key, number][]).map(([k,n]) => <div key={k}><p className="text-xs text-muted-foreground">{t(k)}</p><p className="font-display text-2xl font-bold">{n}</p></div>)}</div>
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]"><div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input className="pl-9" placeholder={t("accessSearch")} value={search} onChange={(e) => setSearch(e.target.value)} /></div><Select value={filter} onValueChange={setFilter}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{([['all','allUsers'],['admin','ownerRole'],['salesman','salesmanRole'],['inactive','inactive']] as [string,Key][]).map(([v,k]) => <SelectItem key={v} value={v}>{t(k)}</SelectItem>)}</SelectContent></Select></div>
    {isLoading && <p>{t("loading")}</p>}{error && <div><p className="text-destructive">{t("loadFailed")}</p><Button onClick={() => void refetch()}>{t("retry")}</Button></div>}
    <div className="divide-y">{users.filter((u) => `${u.full_name} ${u.phone ?? ''}`.toLowerCase().includes(search.toLowerCase()) && (filter === "all" || (filter === "inactive" ? !u.active : u.role === filter))).map((u) => <div key={u.id} className="flex flex-wrap items-center justify-between gap-3 py-4"><div className="min-w-0"><p className="break-words font-semibold">{u.full_name || u.id.slice(0,8)} {me?.id === u.id && <span className="text-xs text-muted-foreground">· {t("currentUser")}</span>}</p><p className="text-sm text-muted-foreground">{u.phone} · {t(u.role === "admin" ? "ownerRole" : "salesmanRole")} · <span className={u.active ? "text-success" : "text-destructive"}>{t(u.active ? "active" : "inactive")}</span></p><p className="text-xs text-muted-foreground">{t(u.role === "admin" ? "allData" : "ownData")}</p></div><Button variant="outline" disabled={!online} onClick={() => { setEdit(u); setReason(""); setConfirming(false); }}>{t("manageAccess")}</Button></div>)}</div>
    <section className="space-y-3 border-t pt-6"><h2 className="font-display text-lg font-bold">{t("permissions")}</h2><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="py-2 text-left">{t("items")}</th><th>{t("ownerRole")}</th><th>{t("salesmanRole")}</th></tr></thead><tbody>{ACTION_PERMISSIONS.map((p) => <tr key={p} className="border-b"><td className="py-3">{t(permissionLabel[p] ?? "permissions")}</td><td className="text-center"><Check className="mx-auto h-4 w-4 text-success" /></td><td className="text-center">{t("permissions")}</td></tr>)}{(["stockIssue","userAccess","backup","paymentRisk"] as Key[]).map((k) => <tr key={k} className="border-b"><td className="py-3">{t(k)}</td><td className="text-center"><Check className="mx-auto h-4 w-4 text-success" /></td><td><Minus className="mx-auto h-4 w-4 text-muted-foreground" /></td></tr>)}</tbody></table></div></section>
    <section className="space-y-3 border-t pt-6"><h2 className="font-display text-lg font-bold">{t("accessHistory")}</h2>{history.length === 0 && <p className="text-muted-foreground">{t("noData")}</p>}{history.map((h) => <div key={h.id} className="border-b pb-3 text-sm"><p className="font-semibold">{users.find((u) => u.id === h.entity_id)?.full_name ?? h.entity_id?.slice(0,8)}</p><p className="break-words">{h.reason}</p><p className="text-xs text-muted-foreground">{users.find((u) => u.id === h.actor)?.full_name} · {new Date(h.created_at).toLocaleString()}</p></div>)}</section>
    <Dialog open={edit !== null} onOpenChange={(o) => { if (!o && !busy) setEdit(null); }}><DialogContent className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>{t("manageAccess")} · {edit?.full_name}</DialogTitle></DialogHeader>{edit && <div className="space-y-4">{confirming ? <p className="text-sm text-destructive">{t("accessConfirm")}</p> : <>
      <div className="space-y-1"><Label>{t("role")}</Label><Select value={edit.role} disabled={edit.id === me?.id} onValueChange={(v) => setEdit({ ...edit, role: v === "admin" ? "admin" : "salesman" })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="admin">{t("ownerRole")}</SelectItem><SelectItem value="salesman">{t("salesmanRole")}</SelectItem></SelectContent></Select></div>
      <label className="flex items-center justify-between gap-3">{t("active")}<Switch checked={edit.active} disabled={edit.id === me?.id} onCheckedChange={(v) => setEdit({ ...edit, active: v })} /></label>
      {edit.id === me?.id && <p className="text-xs text-muted-foreground">{t("selfProtected")}</p>}
      <div className="space-y-3 border-t pt-3"><Label>{t("permissions")}</Label>{ACTION_PERMISSIONS.map((p) => <label key={p} className="flex items-center justify-between gap-3 text-sm">{t(permissionLabel[p] ?? "permissions")}<Switch checked={edit.role === "admin" || edit.permissions[p]} disabled={edit.role === "admin"} onCheckedChange={(v) => setEdit({ ...edit, permissions: { ...edit.permissions, [p]: v } })} /></label>)}</div>
      <div className="space-y-1"><Label htmlFor="access-reason">{t("reason")}</Label><Input id="access-reason" minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
    </>}<div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => confirming ? setConfirming(false) : setEdit(null)}>{t("cancel")}</Button><Button disabled={busy || !online || reason.trim().length<3} onClick={() => confirming ? void submit() : setConfirming(true)}>{t(confirming ? "confirm" : "save")}</Button></div></div>}</DialogContent></Dialog>
  </div>;
}