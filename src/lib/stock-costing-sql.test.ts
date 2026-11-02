import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const owner = "11111111-1111-4111-8111-111111111111";
const salesman = "22222222-2222-4222-8222-222222222222";
const product = "33333333-3333-4333-8333-333333333333";
const legacyProduct = "44444444-4444-4444-8444-444444444444";
const smartphone = "55555555-5555-4555-8555-555555555555";
const retailer = "66666666-6666-4666-8666-666666666666";
const imei = "490154203237518";

type ReceiptOperation = {
  id: string;
};

describe("audited purchase receipts and FIFO costing", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(
      `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
       CREATE SCHEMA auth;
       CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_user_meta_data jsonb DEFAULT '{}',raw_app_meta_data jsonb DEFAULT '{}');
       CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('app.user',true),'')::uuid $$;`,
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
      if (file === "0003_dealer_risk_and_confirmed_blocks.sql") {
        await db.exec(
          "ALTER TABLE products ADD COLUMN low_stock_threshold integer NOT NULL DEFAULT 0",
        );
      }
      await db.exec(readFileSync(`drizzle/migrations/${file}`, "utf8"));
    }
    await db.exec(`
      INSERT INTO auth.users(id,raw_app_meta_data)
      VALUES ('${owner}','{"provisioning":"initial_owner"}'),('${salesman}','{"provisioning":"owner_created_salesman"}');
      SELECT set_config('app.user','${owner}',false);
      INSERT INTO products(id,name,price,is_smartphone,stock_qty)
      VALUES
        ('${product}','FIFO phone',100,false,0),
        ('${legacyProduct}','Legacy phone',80,false,3),
        ('${smartphone}','Smartphone',200,true,0);
      INSERT INTO retailers(id,name,salesman_id) VALUES('${retailer}','Test shop','${salesman}');
    `);
    await db.exec(
      readFileSync("drizzle/migrations/0015_audited_stock_receipts_and_costs.sql", "utf8"),
    );
    await db.exec(
      readFileSync("drizzle/migrations/0016_cost_reporting_backup_and_cancellation.sql", "utf8"),
    );
    await db.exec(
      readFileSync("drizzle/migrations/0017_supplier_due_ledger_and_receipts.sql", "utf8"),
    );
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  async function setUser(userId: string) {
    await db.query("SELECT set_config('app.user',$1,false)", [userId]);
  }

  async function receive(
    id: string,
    productId: string,
    quantity: number,
    unitCost: number,
    imeis: string[] = [],
  ) {
    const payload = {
      _product: productId,
      _imeis: imeis,
      _quantity: quantity,
      _supplier: "Verified supplier",
      _purchase_reference: "INV-001",
      _batch_reference: `B-${id.slice(0, 4)}`,
      _unit_cost: unitCost,
      _received_on: "2026-10-01",
      _note: "Stock received",
    };
    const result = await db.query<{ data: ReceiptOperation }>(
      "SELECT perform_stock_receipt_operation($1,$2::jsonb) data",
      [id, JSON.stringify(payload)],
    );
    return result.rows[0]?.data.id;
  }

  it("uses a stable operation ID to prevent duplicate receipts", async () => {
    await setUser(owner);
    const operationId = "77777777-7777-4777-8777-777777777777";
    const first = await receive(operationId, product, 2, 20);
    const retry = await receive(operationId, product, 2, 20);
    expect(retry).toBe(first);
    expect(
      (
        await db.query<{ stock_qty: number }>("SELECT stock_qty FROM products WHERE id=$1", [
          product,
        ])
      ).rows[0]?.stock_qty,
    ).toBe(2);
    await expect(receive(operationId, product, 1, 25)).rejects.toThrow("different request");
    expect(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int n FROM stock_receipts WHERE product_id=$1",
          [product],
        )
      ).rows[0]?.n,
    ).toBe(1);
  });

  it("issues button-phone stock FIFO and preserves each receipt's actual cost", async () => {
    await setUser(owner);
    await receive("88888888-8888-4888-8888-888888888888", product, 2, 30);
    await receive("99999999-9999-4999-8999-999999999999", product, 2, 40);
    const receiptLots = await db.query<{ unit_cost: string; quantity_remaining: number }>(
      "SELECT unit_cost,quantity_remaining FROM stock_receipts WHERE product_id=$1 ORDER BY receipt_order",
      [product],
    );
    expect(receiptLots.rows.map((row) => [Number(row.unit_cost), row.quantity_remaining])).toEqual([
      [20, 2],
      [30, 2],
      [40, 2],
    ]);
    await db.query("SELECT issue_stock($1,$2::jsonb)", [
      salesman,
      JSON.stringify([{ product_id: product, qty: 3 }]),
    ]);

    const issues = await db.query<{ receipt_id: string; qty: number; unit_cost: string }>(
      `SELECT m.receipt_id,m.qty,m.unit_cost FROM stock_movements m
       JOIN stock_receipts r ON r.id=m.receipt_id
       WHERE m.kind='issue' AND m.product_id=$1 ORDER BY r.receipt_order`,
      [product],
    );
    expect(issues.rows.map((row) => [row.qty, Number(row.unit_cost)])).toEqual([
      [2, 20],
      [1, 30],
    ]);
    expect(issues.rows.reduce((sum, row) => sum + row.qty * Number(row.unit_cost), 0)).toBe(70);
    expect(
      (
        await db.query<{ quantity_remaining: number }>(
          "SELECT quantity_remaining FROM stock_receipts WHERE id=$1",
          [issues.rows[0]?.receipt_id],
        )
      ).rows[0]?.quantity_remaining,
    ).toBe(0);
  });

  it("reports known-cost profit separately and keeps legacy cost explicitly unknown", async () => {
    await setUser(salesman);
    await db.query("SELECT record_sale($1,$2::jsonb,0)", [
      retailer,
      JSON.stringify([{ product_id: product, qty: 1, unit_price: 100 }]),
    ]);
    await db.query("SELECT return_stock($1,$2::jsonb)", [
      salesman,
      JSON.stringify([{ product_id: product, qty: 1 }]),
    ]);
    await setUser(owner);
    await db.query("SELECT issue_stock($1,$2::jsonb)", [
      salesman,
      JSON.stringify([{ product_id: legacyProduct, qty: 1 }]),
    ]);
    await setUser(salesman);
    await db.query("SELECT record_sale($1,$2::jsonb,0)", [
      retailer,
      JSON.stringify([{ product_id: legacyProduct, qty: 1, unit_price: 80 }]),
    ]);

    const summary = (
      await db.query<{
        data: {
          products: {
            product_id: string;
            value: number;
            unknownCostHand: number;
            knownGrossProfit: number;
          }[];
          owesDealer: number;
          owesDealerUnknownQty: number;
          unknownCostSoldQty: number;
        };
      }>("SELECT salesman_account_summary($1) data", [salesman])
    ).rows[0]?.data;
    expect(summary?.products.find((row) => row.product_id === product)).toMatchObject({
      value: 20,
      unknownCostHand: 0,
      knownGrossProfit: 80,
    });
    expect(summary?.products.find((row) => row.product_id === legacyProduct)).toMatchObject({
      value: 0,
      unknownCostHand: 0,
      knownGrossProfit: 0,
    });
    expect(summary?.owesDealer).toBe(40);
    expect(summary?.owesDealerUnknownQty).toBe(1);
    expect(summary?.unknownCostSoldQty).toBe(1);

    await setUser(owner);
    const dashboard = (
      await db.query<{
        data: {
          warehouseValue: number;
          warehouseUnknownCostQty: number;
          heldValue: number;
          heldUnknownCostQty: number;
          knownGrossProfit: number;
          unknownCostSoldQty: number;
        };
      }>("SELECT distribution_insights() data")
    ).rows[0]?.data;
    expect(dashboard).toMatchObject({
      warehouseValue: 140,
      warehouseUnknownCostQty: 2,
      heldValue: 20,
      heldUnknownCostQty: 0,
      knownGrossProfit: 80,
      unknownCostSoldQty: 1,
    });
  });

  it("cancels the latest return by reversing its receipt and physical stock", async () => {
    await setUser(owner);
    const returnedMove = (
      await db.query<{ id: string }>(
        "SELECT id FROM stock_movements WHERE product_id=$1 AND kind='return' ORDER BY created_at DESC,id DESC LIMIT 1",
        [product],
      )
    ).rows[0]?.id;
    expect(returnedMove).toBeTruthy();
    await db.query("SELECT cancel_business_history('stock_movements',$1,'Reverse latest return')", [
      returnedMove,
    ]);
    expect(
      (
        await db.query<{ stock_qty: number }>("SELECT stock_qty FROM products WHERE id=$1", [
          product,
        ])
      ).rows[0]?.stock_qty,
    ).toBe(3);
    expect(
      (await db.query<{ qty: number }>("SELECT holding_qty($1,$2) qty", [salesman, product]))
        .rows[0]?.qty,
    ).toBe(2);
  });

  it("records smartphone IMEIs through a validated, audited receipt", async () => {
    await setUser(owner);
    const directWriteAccess = await db.query<{
      imei_insert: boolean;
      movement_insert: boolean;
      sale_insert: boolean;
      receipt_execute: boolean;
    }>(`
      SELECT has_table_privilege('authenticated','public.imei_units','INSERT') imei_insert,
        has_table_privilege('authenticated','public.stock_movements','INSERT') movement_insert,
        has_table_privilege('authenticated','public.sales','INSERT') sale_insert,
        has_function_privilege('authenticated',
          'public.receive_stock(uuid,jsonb,integer,text,text,text,numeric,date,text)','EXECUTE') receipt_execute
    `);
    expect(directWriteAccess.rows[0]).toEqual({
      imei_insert: false,
      movement_insert: false,
      sale_insert: false,
      receipt_execute: false,
    });
    const receiptId = await receive("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", smartphone, 1, 150, [
      imei,
    ]);
    const unit = (
      await db.query<{ receipt_id: string; status: string }>(
        "SELECT receipt_id,status FROM imei_units WHERE imei=$1",
        [imei],
      )
    ).rows[0];
    expect(unit).toEqual({ receipt_id: receiptId, status: "in_stock" });
    expect(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int n FROM business_audit WHERE entity_id=$1 AND action='stock_receive'",
          [receiptId],
        )
      ).rows[0]?.n,
    ).toBe(1);
    await expect(
      receive("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", smartphone, 1, 150, ["123"]),
    ).rejects.toThrow();
    await db.query("SELECT issue_stock($1,$2::jsonb)", [
      salesman,
      JSON.stringify([{ product_id: smartphone, imeis: [imei] }]),
    ]);
    expect(
      (
        await db.query<{ quantity_remaining: number }>(
          "SELECT quantity_remaining FROM stock_receipts WHERE id=$1",
          [receiptId],
        )
      ).rows[0]?.quantity_remaining,
    ).toBe(0);
    await setUser(salesman);
    await db.query("SELECT return_stock($1,$2::jsonb)", [
      salesman,
      JSON.stringify([{ product_id: smartphone, imeis: [imei] }]),
    ]);
    expect(
      (
        await db.query<{ status: string; receipt_id: string }>(
          "SELECT status,receipt_id FROM imei_units WHERE imei=$1",
          [imei],
        )
      ).rows[0],
    ).toEqual({ status: "in_stock", receipt_id: receiptId });
    expect(
      (
        await db.query<{ quantity_remaining: number }>(
          "SELECT quantity_remaining FROM stock_receipts WHERE id=$1",
          [receiptId],
        )
      ).rows[0]?.quantity_remaining,
    ).toBe(1);
  });

  it("round-trips v3 receipts/payments and restores v1 exports as unknown-cost stock", async () => {
    await setUser(owner);
    const original = (
      await db.query<{ data: Record<string, unknown> }>("SELECT export_business_data() data")
    ).rows[0]?.data;
    const safety = (
      await db.query<{ data: { source: string } }>("SELECT export_business_data() data")
    ).rows[0]?.data;
    await db.query("SELECT restore_business_data('RESTORE FIROZA',$1::jsonb,$2)", [
      JSON.stringify(original),
      safety?.source,
    ]);
    expect(
      (await db.query<{ n: number }>("SELECT count(*)::int n FROM stock_receipts")).rows[0]?.n,
    ).toBeGreaterThan(0);
    expect((original as { version: number }).version).toBe(3);

    const legacyTables = {
      products: [
        {
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          name: "Old backup item",
          model: null,
          price: 75,
          is_smartphone: false,
          stock_qty: 3,
          low_stock_threshold: 0,
          created_at: "2026-10-01T00:00:00Z",
        },
      ],
      retailers: [],
      imei_units: [],
      sales: [],
      stock_movements: [],
      retailer_payments: [],
      deposits: [],
      dealer_blocks: [],
      dealer_risk_assessments: [],
    };
    const oldExportId = (
      await db.query<{ id: string }>(
        "INSERT INTO business_exports(actor,snapshot) VALUES($1,$2::jsonb) RETURNING id",
        [owner, JSON.stringify(legacyTables)],
      )
    ).rows[0]?.id;
    const currentSafety = (
      await db.query<{ data: { source: string } }>("SELECT export_business_data() data")
    ).rows[0]?.data;
    const oldBackup = {
      format: "firoza-business-data",
      version: 1,
      source: oldExportId,
      exported_at: "2026-10-01T00:00:00Z",
      tables: legacyTables,
    };
    await db.query("SELECT restore_business_data('RESTORE FIROZA',$1::jsonb,$2)", [
      JSON.stringify(oldBackup),
      currentSafety?.source,
    ]);
    const restored = await db.query<{ unit_cost: number | null; quantity_remaining: number }>(
      "SELECT unit_cost,quantity_remaining FROM stock_receipts WHERE product_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'",
    );
    expect(restored.rows).toEqual([{ unit_cost: null, quantity_remaining: 3 }]);
  });

  it("aggregates supplier dues and makes payment retries/editing safe", async () => {
    await setUser(owner);
    await db.query("INSERT INTO retailers(id,name,salesman_id) VALUES($1,'Payment test shop',$2)", [
      retailer,
      salesman,
    ]);
    await db.query("INSERT INTO sales(salesman_id,retailer_id,total,paid) VALUES($1,$2,20,0)", [
      salesman,
      retailer,
    ]);
    const retailerPaymentPayload = { retailer_id: retailer, amount: 5, note: "Collection" };
    const retailerPaymentId = "12121212-1212-4121-8121-121212121212";
    const collected = await db.query<{ data: { id: string } }>(
      "SELECT perform_business_operation($1,'retailer_payment',$2::jsonb) data",
      [retailerPaymentId, JSON.stringify(retailerPaymentPayload)],
    );
    const collectedRetry = await db.query<{ data: { id: string } }>(
      "SELECT perform_business_operation($1,'retailer_payment',$2::jsonb) data",
      [retailerPaymentId, JSON.stringify(retailerPaymentPayload)],
    );
    expect(collectedRetry.rows[0]?.data.id).toBe(collected.rows[0]?.data.id);
    await expect(
      db.query("SELECT perform_business_operation($1,'retailer_payment',$2::jsonb)", [
        "13131313-1313-4131-8131-131313131313",
        JSON.stringify({ retailer_id: retailer, amount: 16 }),
      ]),
    ).rejects.toThrow("Payment exceeds retailer due");

    await db.query(
      "INSERT INTO products(id,name,price,is_smartphone,stock_qty) VALUES($1,'Supplier test phone',20,false,0) ON CONFLICT(id) DO NOTHING",
      [product],
    );
    await receive("ffffffff-ffff-4fff-8fff-ffffffffffff", product, 1, 20);
    const summaryBefore = (
      await db.query<{ data: { supplier: string; due: number | string }[] }>(
        "SELECT supplier_due_summary() data",
      )
    ).rows[0]?.data;
    const before = Number(summaryBefore?.find((row) => row.supplier === "Verified supplier")?.due);
    expect(before).toBeGreaterThan(0);

    const operationId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const payload = { supplier: "Verified supplier", amount: 5, note: "Supplier payment" };
    const first = await db.query<{ data: { id: string } }>(
      "SELECT perform_supplier_payment_operation($1,$2::jsonb) data",
      [operationId, JSON.stringify(payload)],
    );
    const retry = await db.query<{ data: { id: string } }>(
      "SELECT perform_supplier_payment_operation($1,$2::jsonb) data",
      [operationId, JSON.stringify(payload)],
    );
    expect(retry.rows[0]?.data.id).toBe(first.rows[0]?.data.id);
    expect(
      (
        await db.query<{ count: number }>(
          "SELECT count(*)::int count FROM supplier_payments WHERE supplier='Verified supplier'",
        )
      ).rows[0]?.count,
    ).toBe(1);

    const paymentId = first.rows[0]?.data.id;
    await db.query(
      "SELECT manage_supplier_payment($1,'update',3,'Corrected amount','Audit test')",
      [paymentId],
    );
    const summaryAfter = (
      await db.query<{ data: { supplier: string; due: number | string }[] }>(
        "SELECT supplier_due_summary() data",
      )
    ).rows[0]?.data;
    expect(Number(summaryAfter?.find((row) => row.supplier === "Verified supplier")?.due)).toBe(
      before - 3,
    );
    expect(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int n FROM business_audit WHERE entity='supplier_payments' AND action='update'",
        )
      ).rows[0]?.n,
    ).toBe(1);

    const backup = (
      await db.query<{ data: Record<string, unknown> }>("SELECT export_business_data() data")
    ).rows[0]?.data;
    const safety = (
      await db.query<{ data: { source: string } }>("SELECT export_business_data() data")
    ).rows[0]?.data;
    await db.query("SELECT restore_business_data('RESTORE FIROZA',$1::jsonb,$2)", [
      JSON.stringify(backup),
      safety?.source,
    ]);
    expect(
      (
        await db.query<{ amount: string }>(
          "SELECT amount FROM supplier_payments WHERE supplier='Verified supplier'",
        )
      ).rows[0]?.amount,
    ).toBe("3.00");
  });
});
