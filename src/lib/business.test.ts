import { describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS, getBusiness } from "./business";

describe("Company letterhead defaults", () => {
  it("uses the requested company name", () => {
    expect(DEFAULT_BUSINESS.name).toBe("FIROZA ENTERPRISE");
  });
  it("uses the requested address", () => {
    expect(DEFAULT_BUSINESS.address).toBe("KONABARI, GAZIPUR");
  });
  it("keeps the leading zero in the requested phone number", () => {
    expect(DEFAULT_BUSINESS.phone).toBe("01817122232");
  });
  it("fills blank old letterhead settings with the company identity", () => {
    localStorage.setItem("business-info", JSON.stringify({ name: "", address: "", phone: "" }));
    expect(getBusiness()).toEqual(DEFAULT_BUSINESS);
    localStorage.removeItem("business-info");
  });
});