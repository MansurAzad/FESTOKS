import { defineConfig } from "drizzle-kit";

const migrationUrl = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env?.SUPABASE_DB_MIGRATION_URL;
if (!migrationUrl) {
  throw new Error("SUPABASE_DB_MIGRATION_URL must be set to the Supabase database connection URL.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./drizzle/schema.ts",
  out: "./drizzle/migrations",
  dbCredentials: {
    url: migrationUrl,
  },
});
