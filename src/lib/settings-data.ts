import { z } from "zod";

export const BUSINESS_TABLES = ["products", "retailers", "imei_units", "sales", "stock_movements", "retailer_payments", "deposits", "dealer_blocks", "dealer_risk_assessments"] as const;
export const RESET_PHRASE = "RESET FIROZA";
export const RESTORE_PHRASE = "RESTORE FIROZA";
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const row = z.record(z.string(), z.unknown());
export const backupSchema = z.object({
  format: z.literal("firoza-business-data"),
  version: z.literal(1),
  source: z.string().uuid(),
  exported_at: z.string().datetime({ offset: true }),
  tables: z.object({
    products: z.array(row), retailers: z.array(row), imei_units: z.array(row),
    sales: z.array(row), stock_movements: z.array(row), retailer_payments: z.array(row),
    deposits: z.array(row), dealer_blocks: z.array(row), dealer_risk_assessments: z.array(row),
  }).strict(),
}).strict();
export type BusinessBackup = z.infer<typeof backupSchema>;
export function parseBusinessBackup(text: string): BusinessBackup {
  if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) throw new Error("Backup exceeds 20 MB");
  return backupSchema.parse(JSON.parse(text));
}
export function backupCounts(backup: BusinessBackup) {
  return BUSINESS_TABLES.map((table) => ({ table, count: backup.tables[table].length }));
}
export const recordSchema = z.object({
  table: z.enum(["products", "retailers", "profiles", "sales", "retailer_payments", "deposits", "stock_movements", "imei_units"]),
  id: z.string().uuid(), action: z.enum(["update", "delete"]),
  values: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).default({}), reason: z.string().trim().min(3).max(500),
});