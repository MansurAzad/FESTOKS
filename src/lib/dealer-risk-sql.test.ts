import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DealerFacts } from "./dealer-risk";

describe("dealer risk history SQL", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec("SELECT 1");
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });
  it("uses sales, FIFO dues, collections and only dealer-linked returns", async () => {
    const source = readFileSync(
      "drizzle/migrations/0003_dealer_risk_and_confirmed_blocks.sql",
      "utf8",
    );
    const start = source.indexOf(" WITH payments AS");
    const end = source.indexOf(";\n RETURN result", start);
    if (start < 0 || end < 0) throw new Error("History query missing");
    let query = source.slice(start, end).replace(" INTO result", "");
    const fixtures = `fixture_retailers AS(SELECT 'a'::text id,'A'::text name,NULL::text phone,'sr'::text salesman_id),
fixture_profiles AS(SELECT 'sr'::text id,'SR'::text full_name),
fixture_sales AS(SELECT * FROM(VALUES('one','a',100::numeric,20::numeric,now()-interval '45 days'),('two','a',80::numeric,0::numeric,now()-interval '10 days')) v(id,retailer_id,total,paid,created_at)),
fixture_retailer_payments AS(SELECT 'a'::text retailer_id,50::numeric amount,now()-interval '5 days' created_at),
fixture_stock_movements AS(SELECT * FROM(VALUES('a'::text,'return'::text,2,10::numeric),(NULL,'return',7,10::numeric)) v(retailer_id,kind,qty,unit_price)),
fixture_dealer_blocks AS(SELECT NULL::text retailer_id,false blocked WHERE false),`;
    query = query.replace("WITH payments", `WITH ${fixtures} payments`);
    for (const table of [
      "retailer_payments",
      "stock_movements",
      "dealer_blocks",
      "retailers",
      "profiles",
      "sales",
    ]) {
      query = query.replace(new RegExp(`(?<!fixture_)\\b${table}\\b`, "g"), `fixture_${table}`);
    }
    const rows = await db.query<{ coalesce: DealerFacts[] }>(query);
    const report = rows.rows[0]?.coalesce;
    if (!report?.[0]) throw new Error("Dealer risk report missing");
    expect(report[0].sales_total).toBe(180);
    expect(report[0].paid_at_sale).toBe(20);
    expect(report[0].collected).toBe(50);
    expect(report[0].total_due).toBe(110);
    expect(report[0].overdue_amount).toBe(30);
    expect(report[0].linked_return_qty).toBe(2);
    expect(report[0].linked_return_value).toBe(20);
    expect(report[0].unattributed_return_count).toBe(1);
  }, 60000);
});
