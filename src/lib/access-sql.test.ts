import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
const owner = "11111111-1111-4111-8111-111111111111",
  sr = "22222222-2222-4222-8222-222222222222",
  product = "33333333-3333-4333-8333-333333333333",
  retailer = "44444444-4444-4444-8444-444444444444";
describe("user role and action enforcement", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(
      `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_user_meta_data jsonb DEFAULT '{}',raw_app_meta_data jsonb DEFAULT '{}'); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('app.user',true),'')::uuid $$;`,
    );
    for (const file of [
      "0000_migration.sql",
      "0003_dealer_risk_and_confirmed_blocks.sql",
      "0004_settings_data_management.sql",
      "0005_validated_history_cancellation.sql",
      "0006_user_roles_access_control.sql",
      "0007_access_read_and_profile_guards.sql",
      "0008_access_role_transition_safety.sql",
      "0009_restrict_internal_access_helpers.sql",
      "0010_urgent_transaction_safety.sql",
      "0011_owner_provisioned_accounts.sql",
      "0012_accounting_reporting_rpc.sql",
      "0013_idempotent_business_operations.sql",
      "0014_json_retailer_balance_summary.sql",
    ]) {
      if (file === "0003_dealer_risk_and_confirmed_blocks.sql")
        await db.exec(
          "ALTER TABLE products ADD COLUMN low_stock_threshold integer NOT NULL DEFAULT 0",
        );
      await db.exec(readFileSync(`drizzle/migrations/${file}`, "utf8"));
    }
    await db.exec(
      `INSERT INTO auth.users(id,raw_app_meta_data) VALUES('${owner}','{"provisioning":"initial_owner"}'),('${sr}','{"provisioning":"owner_created_salesman"}'); SELECT set_config('app.user','${owner}',false); INSERT INTO products(id,name,is_smartphone,stock_qty,price) VALUES('${product}','Stock',false,10,100); INSERT INTO retailers(id,name,salesman_id) VALUES('${retailer}','Shop','${sr}');`,
    );
    await db.query("SELECT issue_stock($1,$2::jsonb)", [
      sr,
      JSON.stringify([{ product_id: product, qty: 3 }]),
    ]);
  }, 60000);
  afterAll(async () => {
    await db?.close();
  });
  async function as(user: string) {
    await db.query("SELECT set_config('app.user',$1,false)", [user]);
  }
  async function set(
    active = true,
    permissions = { sales: true, returns: true, retailer_manage: true, collect_payment: true },
    role = "salesman",
  ) {
    await as(owner);
    await db.query(
      "SELECT manage_user_access($1,$2::app_role,$3,$4::jsonb,'Testing permission change',true)",
      [sr, role, active, JSON.stringify(permissions)],
    );
  }
  it("rejects salesman role escalation and owner self-lockout", async () => {
    await as(sr);
    await expect(
      db.query("SELECT manage_user_access($1,'admin',true,'{}','Escalation',true)", [sr]),
    ).rejects.toThrow("Owner only");
    await as(owner);
    await expect(
      db.query("SELECT manage_user_access($1,'salesman',true,'{}','Demote myself',true)", [owner]),
    ).rejects.toThrow("own owner access");
  });
  it("sales permission is enforced by the real sale function", async () => {
    await set(true, { sales: false, returns: true, retailer_manage: true, collect_payment: true });
    await as(sr);
    await expect(
      db.query("SELECT record_sale($1,$2::jsonb,0)", [
        retailer,
        JSON.stringify([{ product_id: product, qty: 1 }]),
      ]),
    ).rejects.toThrow("Sales permission denied");
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM sales")).rows[0]?.n).toBe(0);
  });
  it("return permission rejects changes without consuming stock", async () => {
    await set(true, { sales: true, returns: false, retailer_manage: true, collect_payment: true });
    await as(sr);
    await expect(
      db.query("SELECT return_stock($1,$2::jsonb)", [
        sr,
        JSON.stringify([{ product_id: product, qty: 1 }]),
      ]),
    ).rejects.toThrow("Action permission denied");
    expect(
      (await db.query<{ q: number }>("SELECT holding_qty($1,$2) q", [sr, product])).rows[0]?.q,
    ).toBe(3);
  });
  it("rejects empty sales, negative payment and negative prices in the database", async () => {
    await set();
    await as(sr);
    await expect(db.query("SELECT record_sale($1,'[]'::jsonb,0)", [retailer])).rejects.toThrow(
      "At least one sale item",
    );
    await expect(
      db.query("SELECT record_sale($1,$2::jsonb,-1)", [
        retailer,
        JSON.stringify([{ product_id: product, qty: 1 }]),
      ]),
    ).rejects.toThrow("cannot be negative");
    await expect(
      db.query("SELECT record_sale($1,$2::jsonb,0)", [
        retailer,
        JSON.stringify([{ product_id: product, qty: 1, unit_price: -5 }]),
      ]),
    ).rejects.toThrow("Unit price cannot be negative");
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM sales")).rows[0]?.n).toBe(0);
  });
  it("receives button-phone stock atomically with an audited reason", async () => {
    await as(owner);
    await db.query("SELECT receive_button_stock($1,5,'Initial purchase')", [product]);
    expect(
      (
        await db.query<{ stock_qty: number }>("SELECT stock_qty FROM products WHERE id=$1", [
          product,
        ])
      ).rows[0]?.stock_qty,
    ).toBe(12);
    expect(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int n FROM business_audit WHERE action='stock_receive' AND reason='Initial purchase'",
        )
      ).rows[0]?.n,
    ).toBe(1);
    await expect(
      db.query("SELECT receive_button_stock($1,0,'No quantity')", [product]),
    ).rejects.toThrow("Positive quantity");
  });
  it("retailer and collection permissions cover direct writes", async () => {
    await set(true, { sales: true, returns: true, retailer_manage: false, collect_payment: false });
    await as(sr);
    await expect(
      db.query("UPDATE retailers SET name='changed' WHERE id=$1", [retailer]),
    ).rejects.toThrow("Retailer management permission denied");
    await expect(
      db.query("INSERT INTO retailer_payments(retailer_id,amount) VALUES($1,10)", [retailer]),
    ).rejects.toThrow("Collection permission denied");
  });
  it("inactive users cannot self-reactivate, mutate stock or read business data via RLS", async () => {
    await set();
    await as(owner);
    await expect(
      db.query(
        "SELECT manage_user_access($1,'salesman',false,$2::jsonb,'Deactivate before return',true)",
        [
          sr,
          JSON.stringify({
            sales: true,
            returns: true,
            retailer_manage: true,
            collect_payment: true,
          }),
        ],
      ),
    ).rejects.toThrow("held stock");
    await db.query("SELECT return_stock($1,$2::jsonb)", [
      sr,
      JSON.stringify([{ product_id: product, qty: 3 }]),
    ]);
    await set(false);
    await as(sr);
    await expect(db.query("UPDATE profiles SET active=true WHERE id=$1", [sr])).rejects.toThrow(
      "Only owner",
    );
    await expect(
      db.query("SELECT return_stock($1,$2::jsonb)", [
        sr,
        JSON.stringify([{ product_id: product, qty: 1 }]),
      ]),
    ).rejects.toThrow("Return more than held");
    expect(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int n FROM stock_movements WHERE kind='return'",
        )
      ).rows[0]?.n,
    ).toBe(1);
    await db.exec(
      "GRANT USAGE ON SCHEMA auth TO authenticated; GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated; SET ROLE authenticated;",
    );
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM products")).rows[0]?.n).toBe(
      0,
    );
    await db.exec("RESET ROLE;");
  });
  it("lets owners return legacy stock from an already inactive salesman", async () => {
    await set();
    await as(owner);
    await db.query("SELECT issue_stock($1,$2::jsonb)", [
      sr,
      JSON.stringify([{ product_id: product, qty: 2 }]),
    ]);
    await db.exec(
      `BEGIN; SELECT set_config('app.manage_user_access','enabled',true); UPDATE profiles SET active=false WHERE id='${sr}'; COMMIT;`,
    );
    await db.query("SELECT return_stock($1,$2::jsonb)", [
      sr,
      JSON.stringify([{ product_id: product, qty: 2 }]),
    ]);
    expect(
      (await db.query<{ q: number }>("SELECT holding_qty($1,$2) q", [sr, product])).rows[0]?.q,
    ).toBe(0);
    await set();
  });
  it("rejects account status changes that bypass the confirmed access RPC", async () => {
    await as(owner);
    await expect(db.query("UPDATE profiles SET active=false WHERE id=$1", [sr])).rejects.toThrow(
      "confirmed account access workflow",
    );
  });
  it("owners have fixed full permissions and changes keep audit records", async () => {
    await set(
      true,
      { sales: false, returns: false, retailer_manage: false, collect_payment: false },
      "admin",
    );
    await as(sr);
    expect(
      (await db.query<{ allowed: boolean }>("SELECT user_can($1,'sales') allowed", [sr])).rows[0]
        ?.allowed,
    ).toBe(true);
    await set();
    expect(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int n FROM business_audit WHERE action='access_change'",
        )
      ).rows[0]?.n,
    ).toBe(10);
  });
  it("rejects public registration and permits owner-provisioned salesman accounts", async () => {
    await expect(
      db.query("INSERT INTO auth.users(id) VALUES('55555555-5555-4555-8555-555555555555')"),
    ).rejects.toThrow("provisioned by the project owner");
    await db.query(
      "INSERT INTO auth.users(id,raw_app_meta_data) VALUES('66666666-6666-4666-8666-666666666666','{\"provisioning\":\"owner_created_salesman\"}')",
    );
    expect(
      (
        await db.query<{ role: string }>(
          "SELECT role::text role FROM user_roles WHERE user_id='66666666-6666-4666-8666-666666666666'",
        )
      ).rows[0]?.role,
    ).toBe("salesman");
  });
  it("uses database aggregates and paginated retailer ledger results", async () => {
    await set();
    await as(owner);
    await db.query("SELECT issue_stock($1,$2::jsonb)", [
      sr,
      JSON.stringify([{ product_id: product, qty: 3 }]),
    ]);
    await as(sr);
    const { rows } = await db.query<{
      result: { products: { hand: number }[]; salesTotal: number };
    }>("SELECT salesman_account_summary($1) result", [sr]);
    expect(rows[0]?.result.products.find((p) => p.hand > 0)?.hand).toBe(3);
    expect(rows[0]?.result.salesTotal).toBe(0);
    await db.query("SELECT record_sale($1,$2::jsonb,0)", [
      retailer,
      JSON.stringify([{ product_id: product, qty: 1 }]),
    ]);
    const page = await db.query<{
      result: { totalCount: number; salesTotal: number; entries: unknown[] };
    }>("SELECT retailer_ledger_page($1,NULL,NULL,1,0) result", [retailer]);
    expect(page.rows[0]?.result).toMatchObject({ totalCount: 1, salesTotal: 100 });
    expect(page.rows[0]?.result.entries).toHaveLength(1);
    const balanceSummary = await db.query<{
      result: Record<string, { sales_total: number | string; sale_paid: number | string }>;
    }>("SELECT retailer_balance_summary() result");
    expect(balanceSummary.rows[0]?.result[retailer]).toMatchObject({
      sales_total: 100,
      sale_paid: 0,
    });
    await db.query(
      "INSERT INTO retailers(id,name,salesman_id) SELECT md5(i::text)::uuid,'Shop '||i,$1 FROM generate_series(1,1005) i",
      [sr],
    );
    const retailerCount = await db.query<{ count: number }>(
      "SELECT count(*)::int count FROM jsonb_object_keys(retailer_balance_summary())",
    );
    expect(retailerCount.rows[0]?.count).toBe(1006);
  });
  it("replays the same operation ID once and rejects cross-request reuse", async () => {
    await set();
    await as(sr);
    const operationId = "77777777-7777-4777-8777-777777777777";
    const payload = JSON.stringify({
      _retailer: retailer,
      _items: [{ product_id: product, qty: 1 }],
      _paid: 0,
    });
    const countBefore = (await db.query<{ n: number }>("SELECT count(*)::int n FROM sales")).rows[0]
      ?.n;
    const first = await db.query<{ result: { id: string } }>(
      "SELECT perform_business_operation($1,'record_sale',$2::jsonb) result",
      [operationId, payload],
    );
    const replay = await db.query<{ result: { id: string } }>(
      "SELECT perform_business_operation($1,'record_sale',$2::jsonb) result",
      [operationId, payload],
    );
    expect(replay.rows[0]?.result.id).toBe(first.rows[0]?.result.id);
    await expect(
      db.query("SELECT perform_business_operation($1,'record_sale',$2::jsonb)", [
        operationId,
        JSON.stringify({
          _retailer: retailer,
          _items: [{ product_id: product, qty: 1 }],
          _paid: 1,
        }),
      ]),
    ).rejects.toThrow("different request");
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM sales")).rows[0]?.n).toBe(
      (countBefore ?? 0) + 1,
    );
    await as(owner);
    await expect(
      db.query("SELECT perform_business_operation($1,'record_sale',$2::jsonb)", [
        operationId,
        payload,
      ]),
    ).rejects.toThrow("different request");
  });
});
