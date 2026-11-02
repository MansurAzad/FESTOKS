import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { accessSchema } from "@/lib/access";
export const saveUserAccess = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator((i) => accessSchema.parse(i)).handler(async ({ data, context }) => {
  const { error } = await context.supabase.rpc("manage_user_access", { _user: data.userId, _role: data.role, _active: data.active, _permissions: data.permissions, _reason: data.reason, _confirmed: data.confirmed });
  if (error) throw new Error(error.message);
  return { ok: true };
});