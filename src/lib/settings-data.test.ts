import { describe, it, expect } from "vitest";
import {
  BUSINESS_TABLES,
  parseBusinessBackup,
  RESET_PHRASE,
  RESTORE_PHRASE,
} from "./settings-data";
const legacyTables = () =>
  Object.fromEntries(
    BUSINESS_TABLES.filter((t) => t !== "stock_receipts" && t !== "supplier_payments").map((t) => [
      t,
      [],
    ]),
  );
const validV1 = () => ({
  format: "firoza-business-data",
  version: 1,
  source: "11111111-1111-4111-8111-111111111111",
  exported_at: "2026-11-02T00:00:00Z",
  tables: legacyTables(),
});
const validV2 = () => ({
  ...validV1(),
  version: 2,
  tables: { ...legacyTables(), stock_receipts: [] },
});
const validV3 = () => ({
  ...validV2(),
  version: 3,
  tables: { ...validV2().tables, supplier_payments: [] },
});
describe("business backup safeguards", () => {
  it("accepts legacy exports and supplier-payment exports", () => {
    const legacy = parseBusinessBackup(JSON.stringify(validV1()));
    const current = parseBusinessBackup(JSON.stringify(validV2()));
    const suppliers = parseBusinessBackup(JSON.stringify(validV3()));
    expect(legacy.version).toBe(1);
    expect(current.version).toBe(2);
    expect(suppliers.version).toBe(3);
    expect(Object.keys(current.tables)).toEqual([
      "products",
      "retailers",
      "imei_units",
      "sales",
      "stock_movements",
      "retailer_payments",
      "deposits",
      "dealer_blocks",
      "dealer_risk_assessments",
      "stock_receipts",
    ]);
    expect(Object.keys(suppliers.tables)).toContain("supplier_payments");
    expect(() =>
      parseBusinessBackup(
        JSON.stringify({ ...validV2(), tables: { ...validV2().tables, user_roles: [] } }),
      ),
    ).toThrow();
  });
  it("rejects incomplete snapshots rather than silently losing lists", () => {
    expect(() =>
      parseBusinessBackup(JSON.stringify({ ...validV2(), tables: { products: [] } })),
    ).toThrow();
  });
  it("requires distinct typed reset and restore confirmations", () => {
    expect(RESET_PHRASE).toBe("RESET FIROZA");
    expect(RESTORE_PHRASE).toBe("RESTORE FIROZA");
  });
});
