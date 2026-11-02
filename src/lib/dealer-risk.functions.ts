import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { requireBlockConfirmation, type DealerFacts } from "./dealer-risk";

export const assessDealerRisk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: owner, error: roleError } = await context.supabase.rpc("has_role", { _user_id: context.userId, _role: "admin" });
    if (roleError || !owner) throw new Error("Owner only");
    const { data: access, error: accessError } = await context.supabase.from("dealer_ai_access").select("denial_message,status").maybeSingle();
    if (accessError) throw new Error(accessError.message);
    if (access) return { error: access.denial_message, status: access.status };
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) return { error: "Lovable AI is not configured.", status: 401 };
    const { data, error } = await context.supabase.rpc("dealer_risk_history");
    if (error) throw new Error(error.message);
    const facts = data as unknown as DealerFacts[];
    if (!facts.length) return { error: null, status: 200 };
    const { scoreDealerBatch } = await import("./dealer-risk.server");
    // Sequential bounded batches avoid huge requests and shared rate-budget bursts.
    const rows = [];
    for (let start = 0; start < facts.length; start += 30) {
      const batch = facts.slice(start, start + 30);
      const result = await scoreDealerBatch(batch, apiKey);
      if (!result.scores) {
        if (result.denied && result.error) {
          const { error: saveError } = await context.supabase.from("dealer_ai_access").upsert({ id: true, denial_message: result.error, status: result.status });
          if (saveError) throw new Error(saveError.message);
        }
        return { error: result.error, status: result.status };
      }
      for (const score of result.scores) {
        const source = batch.find((f) => f.id === score.id);
        if (!source) throw new Error("Unknown dealer in AI response");
        rows.push({ retailer_id: score.id, score: score.score, reason_bn: score.reason_bn, reason_en: score.reason_en, action_bn: score.action_bn, action_en: score.action_en, assessed_at: new Date().toISOString(), assessed_by: context.userId, model: "openai/gpt-6-astra", facts: JSON.parse(JSON.stringify(source)) });
      }
    }
    const { error: saveError } = await context.supabase.from("dealer_risk_assessments").upsert(rows);
    if (saveError) throw new Error(saveError.message);
    return { error: null, status: 200 };
  });

export const setDealerBlock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ retailerId: z.string().uuid(), blocked: z.boolean(), confirmed: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    requireBlockConfirmation(data.confirmed);
    const { error } = await context.supabase.rpc("set_dealer_block", { _retailer: data.retailerId, _blocked: data.blocked, _confirmed: data.confirmed });
    if (error) throw new Error(error.message);
    return { ok: true };
  });