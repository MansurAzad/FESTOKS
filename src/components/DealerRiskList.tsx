import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BrainCircuit, Phone, ShieldBan } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useT } from "@/lib/i18n";
import { money } from "@/lib/imei";
import { rankDealers, type Assessment, type DealerFacts } from "@/lib/dealer-risk";
import { assessDealerRisk, setDealerBlock } from "@/lib/dealer-risk.functions";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from "@/components/ui/alert-dialog";

export function DealerRiskList() {
  const { t, lang } = useT();
  const client = useQueryClient();
  const assess = useServerFn(assessDealerRisk);
  const changeBlock = useServerFn(setDealerBlock);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DealerFacts | null>(null);
  const query = useQuery({ queryKey: ["dealer-risk"], queryFn: async () => {
    const [history, scores, access] = await Promise.all([
      supabase.rpc("dealer_risk_history"),
      supabase.from("dealer_risk_assessments").select("retailer_id,score,reason_bn,reason_en,action_bn,action_en,assessed_at,facts"),
      supabase.from("dealer_ai_access").select("denial_message").maybeSingle(),
    ]);
    if (history.error || scores.error || access.error) throw new Error(history.error?.message ?? scores.error?.message ?? access.error?.message);
    return { dealers: rankDealers(history.data as unknown as DealerFacts[], scores.data as unknown as Assessment[]), denial: access.data?.denial_message };
  } });
  async function runAssessment() {
    setBusy(true); setError(null);
    try {
      const result = await assess();
      if (result.error) setError(result.error);
      await client.invalidateQueries({ queryKey: ["dealer-risk"] });
    } catch (e) { setError(e instanceof Error ? e.message : t("loadFailed")); }
    finally { setBusy(false); }
  }
  async function confirmBlock() {
    if (!selected) return;
    setSaving(true); setError(null);
    try {
      await changeBlock({ data: { retailerId: selected.id, blocked: !selected.blocked, confirmed: true } });
      setSelected(null);
      await client.invalidateQueries();
    } catch (e) { setError(e instanceof Error ? e.message : t("loadFailed")); }
    finally { setSaving(false); }
  }
  return <section className="border-y py-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <h2 className="flex items-center gap-2 text-lg font-bold"><BrainCircuit className="h-5 w-5 shrink-0" />{t("paymentRisk")}</h2>
      <Button size="sm" variant="outline" onClick={runAssessment} disabled={busy || query.isPending || query.isError || !!query.data?.denial || !query.data?.dealers.length}><BrainCircuit className={busy ? "h-4 w-4 animate-pulse motion-reduce:animate-none" : "h-4 w-4"} />{t(busy ? "assessingRisk" : "assessRisk")}</Button>
    </div>
    {(error || query.data?.denial) && <p role="alert" className="mt-3 break-words text-sm text-destructive">{error ?? query.data?.denial}</p>}
    {query.isPending && <p role="status" className="mt-3 text-sm">{t("loading")}</p>}
    {query.isError && <div className="mt-3 flex items-center gap-2"><p className="text-destructive">{t("loadFailed")}</p><Button variant="outline" onClick={() => query.refetch()}>{t("retry")}</Button></div>}
    {query.data?.dealers.length === 0 && <p className="mt-3 text-sm text-muted-foreground">{t("noData")}</p>}
    <ol className="mt-3 divide-y">
      {query.data?.dealers.map((d, index) => <li key={d.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-4">
        <div className="min-w-0">
          <div className="break-words font-semibold">{index + 1}. {d.name} {d.blocked && <span className="text-xs text-destructive">· {t("blocked")}</span>}</div>
          {d.salesman_name && <p className="text-xs text-muted-foreground">{d.salesman_name}</p>}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs"><span>{t("sales")}: {money(d.sales_total)}</span><span>{t("totalCollected")}: {money(d.paid_at_sale + d.collected)}</span><span>{t("totalDue")}: {money(d.total_due)}</span><span className="text-destructive">{t("overdueBalance")}: {money(d.overdue_amount)} · {d.age_days} {t("days")}</span></div>
          <p className="mt-2 break-words text-sm">{d.assessment ? (lang === "bn" ? d.assessment.reason_bn : d.assessment.reason_en) : t("noAssessment")}</p>
          {d.assessment && <><p className="mt-1 break-words text-sm font-medium">{lang === "bn" ? d.assessment.action_bn : d.assessment.action_en}</p><p className="mt-1 text-xs text-muted-foreground">{t("assessedAt")}: {new Date(d.assessment.assessed_at).toLocaleString(lang === "bn" ? "bn-BD" : "en-GB", { timeZone: "Asia/Dhaka" })}</p></>}
          {(d.unattributed_return_count > 0 || d.linked_return_qty === 0) && <p className="mt-1 text-xs text-muted-foreground">{t("returnHistoryGap")}</p>}
          {d.stale && <p className="mt-1 text-xs text-destructive">{t("staleAssessment")}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {d.phone && <Button asChild size="sm" variant="outline"><a href={`tel:${d.phone}`}><Phone className="h-4 w-4" />{d.phone}</a></Button>}
            <Button size="sm" variant="outline" onClick={() => setSelected(d)}><ShieldBan className="h-4 w-4" />{t(d.blocked ? "unblockDealer" : "blockDealer")}</Button>
          </div>
        </div>
        <div className="min-w-16 text-right"><div className="text-xs text-muted-foreground">{t("riskScore")}</div><div className={`text-2xl font-bold ${d.assessment && d.assessment.score >= 70 ? "text-destructive" : "text-foreground"}`}>{d.assessment ? `${d.assessment.score}/100` : "—"}</div>{d.assessment && <div className="text-xs">{t(d.assessment.score >= 70 ? "highRisk" : d.assessment.score >= 40 ? "mediumRisk" : "lowRisk")}</div>}</div>
      </li>)}
    </ol>
    <AlertDialog open={!!selected} onOpenChange={(open) => { if (!open && !saving) setSelected(null); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{selected?.name}</AlertDialogTitle><AlertDialogDescription>{t(selected?.blocked ? "unblockConfirm" : "blockConfirm")}</AlertDialogDescription></AlertDialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter><Button variant="outline" disabled={saving} onClick={() => setSelected(null)}>{t("cancel")}</Button><Button variant={selected?.blocked ? "default" : "destructive"} disabled={saving} onClick={confirmBlock}>{t("confirm")}</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}