import { z } from "zod";

export const BUSINESS_TABLES = [
  "products",
  "retailers",
  "stock_receipts",
  "imei_units",
  "sales",
  "stock_movements",
  "retailer_payments",
  "supplier_payments",
  "deposits",
  "dealer_blocks",
  "dealer_risk_assessments",
] as const;
export const RESET_PHRASE = "RESET FIROZA";
export const RESTORE_PHRASE = "RESTORE FIROZA";
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const row = z.record(z.string(), z.unknown());
const commonBackup = z.object({
  format: z.literal("firoza-business-data"),
  source: z.string().uuid(),
  exported_at: z.string().datetime({ offset: true }),
});
const legacyTables = z
  .object({
    products: z.array(row),
    retailers: z.array(row),
    imei_units: z.array(row),
    sales: z.array(row),
    stock_movements: z.array(row),
    retailer_payments: z.array(row),
    deposits: z.array(row),
    dealer_blocks: z.array(row),
    dealer_risk_assessments: z.array(row),
  })
  .strict();
const currentTables = legacyTables.extend({ stock_receipts: z.array(row) }).strict();
const supplierTables = currentTables.extend({ supplier_payments: z.array(row) }).strict();
export const backupSchema = z.discriminatedUnion("version", [
  commonBackup.extend({ version: z.literal(1), tables: legacyTables }).strict(),
  commonBackup.extend({ version: z.literal(2), tables: currentTables }).strict(),
  commonBackup.extend({ version: z.literal(3), tables: supplierTables }).strict(),
]);
export type BusinessBackup = z.infer<typeof backupSchema>;
export function parseBusinessBackup(text: string): BusinessBackup {
  if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES)
    throw new Error("Backup exceeds 20 MB");
  return backupSchema.parse(JSON.parse(text));
}
export function backupCounts(backup: BusinessBackup) {
  return BUSINESS_TABLES.flatMap((table) => {
    if (!(table in backup.tables)) return [];
    return [{ table, count: (backup.tables as Record<string, unknown[]>)[table]?.length ?? 0 }];
  });
}
export const recordSchema = z.object({
  table: z.enum([
    "products",
    "retailers",
    "profiles",
    "sales",
    "retailer_payments",
    "supplier_payments",
    "deposits",
    "stock_movements",
    "imei_units",
  ]),
  id: z.string().uuid(),
  action: z.enum(["update", "delete"]),
  values: z
    .record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()]))
    .default({}),
  reason: z.string().trim().min(3).max(500),
});
