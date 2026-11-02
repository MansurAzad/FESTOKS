import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { backupSchema, recordSchema, RESET_PHRASE, RESTORE_PHRASE } from "@/lib/settings-data";
import type { Json } from "@/integrations/supabase/types";

export const exportBusinessData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.rpc("export_business_data");
    if (error) throw new Error(error.message);
    return JSON.stringify(backupSchema.parse(data));
  });

export const resetBusinessData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ confirmation: z.literal(RESET_PHRASE), backupId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const result = await context.supabase.rpc("reset_business_data", {
      _confirmation: data.confirmation,
      _backup_id: data.backupId,
    });
    if (result.error) throw new Error(result.error.message);
    return { ok: true };
  });

export const restoreBusinessData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        confirmation: z.literal(RESTORE_PHRASE),
        backup: backupSchema,
        backupId: z.string().uuid(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const result = await context.supabase.rpc("restore_business_data", {
      _confirmation: data.confirmation,
      _snapshot: JSON.parse(JSON.stringify(data.backup)) as Json,
      _backup_id: data.backupId,
    });
    if (result.error) throw new Error(result.error.message);
    return { ok: true };
  });

export const changeBusinessRecord = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => recordSchema.parse(input))
  .handler(async ({ data, context }) => {
    if (data.table === "sales" || data.table === "stock_movements") {
      if (data.action !== "delete")
        throw new Error("Cancel history then enter a corrected transaction");
      const result = await context.supabase.rpc("cancel_business_history", {
        _table: data.table,
        _id: data.id,
        _reason: data.reason,
      });
      if (result.error) throw new Error(result.error.message);
      return { ok: true };
    }
    if (data.table === "supplier_payments") {
      const amount = Number(data.values["amount"]);
      if (data.action === "update" && (!Number.isFinite(amount) || amount <= 0))
        throw new Error("Positive payment amount required");
      const result = await context.supabase.rpc("manage_supplier_payment", {
        _id: data.id,
        _action: data.action,
        _amount: data.action === "update" ? amount : null,
        _note: data.action === "update" ? String(data.values["note"] ?? "") : null,
        _reason: data.reason,
      });
      if (result.error) throw new Error(result.error.message);
      return { ok: true };
    }
    const result = await context.supabase.rpc("manage_business_record", {
      _table: data.table,
      _id: data.id,
      _action: data.action,
      _values: data.values,
      _reason: data.reason,
    });
    if (result.error) throw new Error(result.error.message);
    return { ok: true };
  });
