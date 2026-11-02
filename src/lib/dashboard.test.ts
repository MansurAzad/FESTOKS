import { describe, expect, it } from "vitest";
import { isLowStock } from "./dashboard";

describe("Per-product low stock warnings", () => {
  it("warns strictly below the configured product limit", () => {
    expect(isLowStock(4, 5)).toBe(true);
    expect(isLowStock(5, 5)).toBe(false);
    expect(isLowStock(6, 5)).toBe(false);
  });
  it("uses a separate limit for each product", () => {
    expect(isLowStock(4, 3)).toBe(false);
    expect(isLowStock(4, 10)).toBe(true);
  });
  it("does not invent alerts before a limit is configured", () => {
    expect(isLowStock(0, 0)).toBe(false);
  });
});