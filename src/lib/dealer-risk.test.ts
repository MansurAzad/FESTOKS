import { describe, expect, it } from "vitest";
import { rankDealers, validateScores, requireBlockConfirmation, type DealerFacts, type Assessment } from "./dealer-risk";
const facts = (id: string): DealerFacts => ({ id, name: id, phone: null, salesman_name: null, invoice_count: 2, sales_total: 1000, paid_at_sale: 100, collected: 200, payment_count: 1, last_payment: null, last_sale: null, total_due: 700, overdue_amount: 400, age_days: 40, linked_return_qty: 0, linked_return_value: 0, unattributed_return_count: 2, blocked: false });
const score = (id: string, n: number): Assessment => ({ id, retailer_id: id, score: n, reason_bn: "", reason_en: "", action_bn: "", action_en: "", assessed_at: "", facts: facts(id) });
describe("dealer payment risk", () => {
  it("ranks higher payment risk first", () => expect(rankDealers([facts("a"), facts("b")], [score("a", 20), score("b", 85)]).map((r) => r.id)).toEqual(["b", "a"]));
  it("rejects invented dealer identities", () => expect(() => validateScores({ dealers: [score("other", 20)] }, [facts("a")])).toThrow());
  it("rejects missing dealers", () => expect(() => validateScores({ dealers: [] }, [facts("a")])).toThrow());
  it("rejects scores outside 0 to 100", () => expect(() => validateScores({ dealers: [score("a", 101)] }, [facts("a")])).toThrow());
  it("does not block without explicit confirmation", () => expect(() => requireBlockConfirmation(false)).toThrow("Explicit owner confirmation required"));
  it("allows explicit confirmation", () => expect(() => requireBlockConfirmation(true)).not.toThrow());
  it("flags changed dues history", () => expect(rankDealers([{ ...facts("a"), total_due: 600 }], [score("a", 80)])[0]?.stale).toBe(true));
  it("does not mistake a block for changed financial history", () => expect(rankDealers([{ ...facts("a"), blocked: true }], [score("a", 80)])[0]?.stale).toBe(false));
});