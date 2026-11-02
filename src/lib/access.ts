import { z } from "zod";
export const ACTION_PERMISSIONS = ["sales", "returns", "retailer_manage", "collect_payment"] as const;
export type ActionPermission = typeof ACTION_PERMISSIONS[number];
export type AccessPermissions = Record<ActionPermission, boolean>;
export const DEFAULT_PERMISSIONS: AccessPermissions = { sales: true, returns: true, retailer_manage: true, collect_payment: true };
export const accessSchema = z.object({ userId: z.string().uuid(), role: z.enum(["admin", "salesman"]), active: z.boolean(), permissions: z.object({ sales: z.boolean(), returns: z.boolean(), retailer_manage: z.boolean(), collect_payment: z.boolean() }).strict(), reason: z.string().trim().min(3).max(500), confirmed: z.literal(true) });