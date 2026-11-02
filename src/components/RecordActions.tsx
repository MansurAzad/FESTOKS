import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { changeBusinessRecord } from "@/lib/settings.functions";
import { useT, type Key } from "@/lib/i18n";
import { useOnline } from "@/lib/offline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { z } from "zod";
import type { recordSchema } from "@/lib/settings-data";

type Table = z.infer<typeof recordSchema>["table"];
type Field = { key: string; label: Key; value: string | number | null; type?: "number" | "text" };
export function RecordActions({ table, id, fields = [], allowDelete = true }: { table: Table; id: string; fields?: Field[]; allowDelete?: boolean }) {
  const { t } = useT();
  const online = useOnline();
  const change = useServerFn(changeBusinessRecord);
  const qc = useQueryClient();
  const [mode, setMode] = useState<"update" | "delete" | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  function open(action: "update" | "delete") {
    setValues(Object.fromEntries(fields.map((f) => [f.key, String(f.value ?? "")])));
    setReason(""); setMode(action);
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (!mode || busy) return;
    setBusy(true);
    try {
      await change({ data: { table, id, action: mode, values, reason } });
      await qc.invalidateQueries(); toast.success(t("done")); setMode(null);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return <>
    <div className="flex shrink-0 gap-1">
      {fields.length > 0 && <Button size="icon" variant="ghost" disabled={!online} aria-label={t("edit")} title={t("edit")} onClick={() => open("update")}><Pencil className="h-4 w-4" /></Button>}
      {allowDelete && <Button size="icon" variant="ghost" disabled={!online} className="text-destructive" aria-label={t(table === "profiles" ? "deactivate" : "remove")} title={t(table === "profiles" ? "deactivate" : "remove")} onClick={() => open("delete")}><Trash2 className="h-4 w-4" /></Button>}
    </div>
    <Dialog open={mode !== null} onOpenChange={(o) => { if (!busy && !o) setMode(null); }}>
      <DialogContent><DialogHeader><DialogTitle>{t(mode === "update" ? "edit" : "remove")}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {mode === "delete" ? <p className="text-sm text-destructive">{t("deleteWarning")}</p> : fields.map((f) => <div className="space-y-1" key={f.key}><Label htmlFor={`record-${id}-${f.key}`}>{t(f.label)}</Label><Input id={`record-${id}-${f.key}`} type={f.type ?? "text"} step={f.type === "number" ? "any" : undefined} required={f.key === "name" || f.key === "full_name" || f.key === "amount" || f.key === "price"} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} /></div>)}
          <div className="space-y-1"><Label htmlFor={`reason-${id}`}>{t("reason")}</Label><Input id={`reason-${id}`} required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => setMode(null)}>{t("cancel")}</Button><Button variant={mode === "delete" ? "destructive" : "default"} disabled={busy || reason.trim().length < 3}>{t("confirm")}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}