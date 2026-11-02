// Runs the actual reporting SQL over temporary CTE fixtures; no live rows are changed.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DashboardInsights } from "./dashboard";

describe("Dashboard database calculations", () => {
  let report: DashboardInsights;
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    const migration = readFileSync("drizzle/migrations/0002_dashboard_alerts_and_kpis.sql", "utf8");
    const body = migration.split("AS $$")[1]?.split("$$;")[0];
    if (!body) throw new Error("Reporting SQL missing");
    const fixtures = `
fixture_sales AS (SELECT * FROM (VALUES
 ('a','old',now()-interval '45 days',100::numeric,20::numeric),
 ('b','old',now()-interval '10 days',80::numeric,0::numeric),
 ('c','boundary',now()-interval '30 days',50::numeric,0::numeric),
 ('d','young',now()-interval '30 days'+interval '1 second',60::numeric,0::numeric),
 ('e','cleared',now()-interval '60 days',70::numeric,0::numeric)
) v(id,retailer_id,created_at,total,paid)),
fixture_retailer_payments AS (SELECT * FROM (VALUES ('old',50::numeric),('cleared',100::numeric)) v(retailer_id,amount)),
fixture_retailers AS (SELECT id,id name,NULL::text phone,NULL::text address,'sr'::text salesman_id FROM (VALUES ('old'),('boundary'),('young'),('cleared')) v(id)),
fixture_profiles AS (SELECT 'sr'::text id,'Salesman'::text full_name,true active),
fixture_user_roles AS (SELECT 'sr'::text user_id,'salesman'::text role),
fixture_products AS (SELECT * FROM (VALUES ('below','Below',4,5),('equal','Equal',5,5),('unset','Unset',0,0)) v(id,name,stock_qty,low_stock_threshold)),
fixture_imei_units AS (SELECT NULL::text product_id,NULL::text status WHERE false),
fixture_stock_movements AS (SELECT NULL::text kind,0 qty,0::numeric unit_price WHERE false),
fixture_deposits AS (SELECT 10::numeric amount),
`;
    let sql = body.replace(/^\s*WITH /, `WITH ${fixtures}`);
    for (const table of [
      "sales",
      "retailer_payments",
      "retailers",
      "profiles",
      "user_roles",
      "products",
      "imei_units",
      "stock_movements",
      "deposits",
    ]) {
      sql = sql.replaceAll(`public.${table}`, `fixture_${table}`);
    }
    sql = sql.replaceAll("public.has_role(auth.uid(),'admin')", "true");
    // Add product fields needed by the real query without assigning live inventory.
    sql = sql.replace(
      "fixture_products p",
      "(SELECT *,NULL::text model,10::numeric price,false is_smartphone FROM fixture_products) p",
    );
    const output = await db.query<{ jsonb_build_object: DashboardInsights }>(sql);
    const result = output.rows[0]?.jsonb_build_object;
    if (!result) throw new Error("No report returned");
    report = result;
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("includes exactly 30-day debt but excludes a younger balance", () => {
    expect(report.overdue.map((r) => r.id).sort()).toEqual(["boundary", "old"]);
  });
  it("subtracts initial payments once and applies collections oldest-first", () => {
    expect(report.overdue.find((r) => r.id === "old")?.overdue_amount).toBe(30);
    expect(report.overdue.find((r) => r.id === "old")?.total_due).toBe(110);
  });
  it("does not move one retailer's excess credit to another retailer", () => {
    expect(report.overdueTotal).toBe(80);
    expect(report.overdue.some((r) => r.id === "cleared")).toBe(false);
  });
  it("warns below each product threshold but not at the threshold", () => {
    expect(report.lowStock.map((p) => p.id)).toEqual(["below"]);
    expect(report.warehouseQty).toBe(9);
    expect(report.warehouseValue).toBe(90);
  });
  it("derives collections and cash from sales, payments and deposits", () => {
    expect(report.collected).toBe(170);
    expect(report.cashInHand).toBe(160);
    expect(report.deposited).toBe(10);
  });
});
