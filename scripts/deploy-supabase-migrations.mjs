import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

await import("./sync-supabase-migrations.mjs");

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const migrationDirectory = join(root, "supabase", "migrations");
const config = await readFile(join(root, "supabase", "config.toml"), "utf8");
let envFile = "";
try {
  envFile = await readFile(join(root, ".env"), "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const projectRef =
  process.env.SUPABASE_PROJECT_ID ??
  envFile
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*SUPABASE_PROJECT_ID\s*=\s*(.*?)\s*$/)?.[1])
    .filter(Boolean)
    .at(-1)
    ?.replace(/^['"]|['"]$/g, "");
const configuredRef = config.match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];

if (!projectRef || configuredRef !== projectRef) {
  throw new Error("SUPABASE_PROJECT_ID must match supabase/config.toml before deployment.");
}

function runSqlFile(contents) {
  const filename = `.migration-runner-${process.pid}-${randomUUID()}.sql`;
  const file = join(migrationDirectory, filename);
  return writeFile(file, contents, "utf8")
    .then(() => {
      const args = [
        "--yes",
        "supabase@latest",
        "db",
        "query",
        "--linked",
        "--workdir",
        root,
        "--output",
        "json",
        "--file",
        file,
      ];
      const output = execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", args, {
        cwd: root,
        encoding: "utf8",
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const jsonStart = output.indexOf("{");
      if (jsonStart < 0) throw new Error("Supabase CLI returned no query result.");
      return JSON.parse(output.slice(jsonStart));
    })
    .catch((error) => {
      const detail = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
      throw new Error(detail || "Supabase CLI migration query failed.", { cause: error });
    })
    .finally(() => unlink(file).catch(() => {}));
}

await runSqlFile(`
BEGIN;
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version text PRIMARY KEY,
  statements text[]
);
COMMIT;
`);

async function getAppliedVersions() {
  const result = await runSqlFile(
    "SELECT coalesce(json_agg(version ORDER BY version), '[]'::json) AS versions FROM supabase_migrations.schema_migrations;",
  );
  const versions = result.rows?.[0]?.versions;
  if (!Array.isArray(versions)) throw new Error("Could not read Supabase migration history.");
  return new Set(versions);
}

const migrations = (await readdir(migrationDirectory))
  .filter((name) => /^\d{14}_[a-zA-Z0-9_-]+\.sql$/.test(name))
  .sort();
if (migrations.length === 0) throw new Error("No timestamped Supabase migrations were found.");

const expectedVersions = new Set(migrations.map((name) => name.slice(0, 14)));
const applied = await getAppliedVersions();
const unexpectedVersions = [...applied].filter((version) => !expectedVersions.has(version));
if (unexpectedVersions.length > 0) {
  throw new Error(
    `Remote migration history has unknown versions: ${unexpectedVersions.join(", ")}`,
  );
}

for (const filename of migrations) {
  const version = filename.slice(0, 14);
  if (applied.has(version)) {
    console.log(`Already applied ${filename}`);
    continue;
  }

  const name = filename.slice(15, -4);
  const sql = await readFile(join(migrationDirectory, filename), "utf8");
  await runSqlFile(`
BEGIN;
DO $migration_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '${version}') THEN
    RAISE EXCEPTION 'Migration ${version} already recorded; refusing to reapply';
  END IF;
END
$migration_guard$;
${sql}
INSERT INTO supabase_migrations.schema_migrations(version, statements)
VALUES ('${version}', NULL);
COMMIT;
`);
  applied.add(version);
  console.log(`Applied ${filename}`);
}

const finalVersions = await getAppliedVersions();
const missingVersions = [...expectedVersions].filter((version) => !finalVersions.has(version));
if (missingVersions.length > 0) {
  throw new Error(`Migration deployment incomplete: ${missingVersions.join(", ")}`);
}

console.log(`Verified ${finalVersions.size} applied Supabase migrations.`);
