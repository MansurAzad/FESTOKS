import { z } from "zod";

export type DealerFacts = {
  id: string; name: string; phone: string | null; salesman_name: string | null;
  invoice_count: number; sales_total: number; paid_at_sale: number; collected: number;
  payment_count: number; last_payment: string | null; last_sale: string | null;
  total_due: number; overdue_amount: number; age_days: number;
  linked_return_qty: number; linked_return_value: number; unattributed_return_count: number; blocked: boolean;
};
export const riskOutputSchema = z.object({ dealers: z.array(z.object({
  id: z.string(), score: z.number(), reason_bn: z.string(), reason_en: z.string(), action_bn: z.string(), action_en: z.string(),
}).strict()) }).strict();
export type RiskScore = z.infer<typeof riskOutputSchema>["dealers"][number];
export type Assessment = RiskScore & { retailer_id: string; assessed_at: string; facts: DealerFacts };

export function validateScores(output: z.infer<typeof riskOutputSchema>, facts: DealerFacts[]) {
  const ids = new Set(facts.map((f) => f.id));
  const seen = new Set<string>();
  for (const d of output.dealers) {
    if (!ids.has(d.id) || seen.has(d.id) || !Number.isInteger(d.score) || d.score < 0 || d.score > 100) throw new Error("Invalid AI dealer assessment");
    seen.add(d.id);
  }
  if (seen.size !== ids.size) throw new Error("Incomplete AI dealer assessment");
  return output.dealers;
}

export function rankDealers(facts: DealerFacts[], assessments: Assessment[]) {
  return facts.map((f) => {
    const assessment = assessments.find((a) => a.retailer_id === f.id);
    const financialFacts = ({ name, phone, salesman_name, blocked, ...rest }: DealerFacts) => rest;
    const stale = assessment ? JSON.stringify(financialFacts(assessment.facts)) !== JSON.stringify(financialFacts(f)) : false;
    return { ...f, assessment, stale };
  }).sort((a, b) => (b.assessment?.score ?? -1) - (a.assessment?.score ?? -1) || b.overdue_amount - a.overdue_amount || b.total_due - a.total_due || a.name.localeCompare(b.name));
}

export function requireBlockConfirmation(confirmed: boolean) {
  if (confirmed !== true) throw new Error("Explicit owner confirmation required");
}