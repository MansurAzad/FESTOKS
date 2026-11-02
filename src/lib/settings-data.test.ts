import { describe, it, expect } from "vitest";
import { BUSINESS_TABLES, parseBusinessBackup, RESET_PHRASE, RESTORE_PHRASE } from "./settings-data";
const valid = () => ({ format: "firoza-business-data", version: 1, source: "11111111-1111-4111-8111-111111111111", exported_at: "2026-11-02T00:00:00Z", tables: Object.fromEntries(BUSINESS_TABLES.map((t) => [t, []])) });
describe("business backup safeguards", () => {
  it("includes business lists, sales, stock and money entries but not login accounts", () => {
    const backup = parseBusinessBackup(JSON.stringify(valid()));
    expect(Object.keys(backup.tables)).toEqual(["products", "retailers", "imei_units", "sales", "stock_movements", "retailer_payments", "deposits", "dealer_blocks", "dealer_risk_assessments"]);
    expect(() => parseBusinessBackup(JSON.stringify({ ...valid(), tables: { ...valid().tables, user_roles: [] } }))).toThrow();
  });
  it("rejects incomplete snapshots rather than silently losing lists", () => {
    expect(() => parseBusinessBackup(JSON.stringify({ ...valid(), tables: { products: [] } }))).toThrow();
  });
  it("requires distinct typed reset and restore confirmations", () => {
    expect(RESET_PHRASE).toBe("RESET FIROZA"); expect(RESTORE_PHRASE).toBe("RESTORE FIROZA");
  });
});