import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
const owner = "11111111-1111-4111-8111-111111111111";
const sr = "22222222-2222-4222-8222-222222222222";
const product = "33333333-3333-4333-8333-333333333333";
const retailer = "44444444-4444-4444-8444-444444444444";
describe("isolated business management database", () => {
  let db: PGlite;
  let backup: { source: string; tables: Record<string, unknown[]> };
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_user_meta_data jsonb DEFAULT '{}'); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('app.user',true),'')::uuid $$;`);
    await db.exec(readFileSync("drizzle/migrations/0000_migration.sql", "utf8"));
    await db.exec("ALTER TABLE products ADD COLUMN low_stock_threshold integer NOT NULL DEFAULT 0;");
    await db.exec(readFileSync("drizzle/migrations/0003_dealer_risk_and_confirmed_blocks.sql", "utf8"));
    await db.exec(readFileSync("drizzle/migrations/0004_settings_data_management.sql", "utf8"));
    await db.exec(readFileSync("drizzle/migrations/0005_validated_history_cancellation.sql", "utf8"));
    await db.exec(`INSERT INTO auth.users(id) VALUES('${owner}'),('${sr}'); SELECT set_config('app.user','${owner}',false); INSERT INTO products(id,name,price,is_smartphone,stock_qty) VALUES('${product}','Test product',100,false,10); INSERT INTO retailers(id,name,salesman_id) VALUES('${retailer}','Test retailer','${sr}');`);
    await db.query("SELECT issue_stock($1,$2::jsonb)", [sr, JSON.stringify([{ product_id: product, qty: 2 }])]);
    await db.query("SELECT set_dealer_block($1,true,true)", [retailer]);
    backup = (await db.query<{ snapshot: typeof backup }>("SELECT export_business_data() snapshot")).rows[0]?.snapshot as typeof backup;
  }, 60000);
  afterAll(async () => { await db?.close(); });
  it("denies salesman reset, export and money correction", async () => {
    await db.exec(`SELECT set_config('app.user','${sr}',false);`);
    await expect(db.query("SELECT export_business_data()")).rejects.toThrow("Owner only");
    await expect(db.query("SELECT reset_business_data('RESET FIROZA',$1)", [backup.source])).rejects.toThrow("Owner confirmation");
    await expect(db.query("SELECT manage_business_record('deposits',$1,'delete','{}','testing')", [product])).rejects.toThrow("Owner only");
    await db.exec(`SELECT set_config('app.user','${owner}',false);`);
  });
  it("requires exact confirmation and an unchanged fresh safety backup", async () => {
    await expect(db.query("SELECT reset_business_data('wrong',$1)", [backup.source])).rejects.toThrow("confirmation");
    await db.exec("UPDATE products SET name='Changed' WHERE name='Test product';");
    await expect(db.query("SELECT reset_business_data('RESET FIROZA',$1)", [backup.source])).rejects.toThrow("fresh backup");
    await db.exec("UPDATE products SET name='Test product' WHERE name='Changed';");
  });
  it("resets all business lists and transactions while keeping login accounts and audit history", async () => {
    await db.query("SELECT reset_business_data('RESET FIROZA',$1)", [backup.source]);
    const rows = await db.query<{ products: number; moves: number; users: number; audits: number }>("SELECT (SELECT count(*)::int FROM products) products,(SELECT count(*)::int FROM stock_movements) moves,(SELECT count(*)::int FROM auth.users) users,(SELECT count(*)::int FROM business_audit) audits");
    expect(rows.rows[0]).toEqual({ products: 0, moves: 0, users: 2, audits: 1 });
  });
  it("restores stock and transactions atomically from the original same-installation export", async () => {
    const safety = (await db.query<{ snapshot: { source: string } }>("SELECT export_business_data() snapshot")).rows[0]?.snapshot;
    await db.query("SELECT restore_business_data('RESTORE FIROZA',$1::jsonb,$2)", [JSON.stringify({ format: "firoza-business-data", version: 1, ...backup }), safety?.source]);
    expect((await db.query<{ stock_qty: number }>("SELECT stock_qty FROM products")).rows[0]?.stock_qty).toBe(8);
    expect((await db.query<{ qty: number }>("SELECT holding_qty($1,$2) qty", [sr, product])).rows[0]?.qty).toBe(2);
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM dealer_blocks")).rows[0]?.n).toBe(0);
  });
  it("rejects modified backups without changing current stock", async () => {
    const safety = (await db.query<{ snapshot: { source: string } }>("SELECT export_business_data() snapshot")).rows[0]?.snapshot;
    await expect(db.query("SELECT restore_business_data('RESTORE FIROZA',$1::jsonb,$2)", [JSON.stringify({ format: "firoza-business-data", version: 1, ...backup, tables: { ...backup.tables, products: [] } }), safety?.source])).rejects.toThrow("modified");
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM products")).rows[0]?.n).toBe(1);
  });
  it("prevents deleting products with stock and validates cancelling an issue", async () => {
    await expect(db.query("SELECT manage_business_record('products',$1,'delete','{}','testing')", [product])).rejects.toThrow("stock or history");
    const movement = (await db.query<{ id: string }>("SELECT id FROM stock_movements WHERE kind='issue'")).rows[0]?.id;
    await db.query("SELECT cancel_business_history('stock_movements',$1,'testing cancellation')", [movement]);
    expect((await db.query<{ stock_qty: number }>("SELECT stock_qty FROM products")).rows[0]?.stock_qty).toBe(10);
    expect((await db.query<{ qty: number }>("SELECT holding_qty($1,$2) qty", [sr, product])).rows[0]?.qty).toBe(0);
  });
  it("retailer CRUD keeps salesman ownership and denies another salesman", async () => {
    await db.exec(`SELECT set_config('app.user','${sr}',false);`);
    await db.query("SELECT manage_business_record('retailers',$1,'update',$2::jsonb,'Contact correction')", [retailer, JSON.stringify({ name: "Updated", phone: "123", address: "Test" })]);
    expect((await db.query<{ name: string; salesman_id: string }>("SELECT name,salesman_id FROM retailers WHERE id=$1", [retailer])).rows[0]).toEqual({ name: "Updated", salesman_id: sr });
    await db.exec("SELECT set_config('app.user','55555555-5555-4555-8555-555555555555',false);");
    await expect(db.query("SELECT manage_business_record('retailers',$1,'delete','{}','Delete attempt')", [retailer])).rejects.toThrow("not available");
    await db.exec(`SELECT set_config('app.user','${owner}',false);`);
  });
  it("money updates and deletes retain an audit trail and concrete balances", async () => {
    const d = (await db.query<{ id: string }>("INSERT INTO deposits(salesman_id,amount) VALUES($1,20) RETURNING id", [sr])).rows[0]?.id;
    await db.query("SELECT manage_business_record('deposits',$1,'update',$2::jsonb,'Correct amount')", [d, JSON.stringify({ amount: 30, note: "Verified" })]);
    expect((await db.query<{ amount: string }>("SELECT amount FROM deposits WHERE id=$1", [d])).rows[0]?.amount).toBe("30.00");
    await db.query("SELECT manage_business_record('deposits',$1,'delete','{}','Cancel duplicate')", [d]);
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM deposits WHERE id=$1", [d])).rows[0]?.n).toBe(0);
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM business_audit WHERE entity_id=$1", [d])).rows[0]?.n).toBe(2);
  });
});