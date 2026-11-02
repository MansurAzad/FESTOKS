import { describe, expect, it } from "vitest";
import { extractImei, isValidImeiFormat } from "./imei";

describe("IMEI rules", () => {
  it("accepts a valid 15-digit Luhn IMEI", () => {
    expect(isValidImeiFormat("490154203237518")).toBe(true);
  });
  it("rejects a wrong checksum IMEI", () => {
    expect(isValidImeiFormat("490154203237519")).toBe(false);
  });
  it("rejects IMEI with wrong length", () => {
    expect(isValidImeiFormat("49015420323751")).toBe(false);
  });
  it("extracts IMEI from scanned barcode text", () => {
    expect(extractImei("IMEI1: 490154203237518")).toBe("490154203237518");
  });
});
