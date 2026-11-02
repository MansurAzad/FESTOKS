import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(".");
const sourceDirectory = join(root, "drizzle", "migrations");
const targetDirectory = join(root, "supabase", "migrations");
const journal = JSON.parse(await readFile(join(sourceDirectory, "meta", "_journal.json"), "utf8"));

if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
  throw new Error("Drizzle migration journal is empty or invalid.");
}

await mkdir(targetDirectory, { recursive: true });
const entries = [...journal.entries].sort((a, b) => a.when - b.when);
const expectedFiles = new Set();
let previousWhen = 0;

for (const entry of entries) {
  if (!Number.isSafeInteger(entry.when) || entry.when <= previousWhen || !/^[a-zA-Z0-9_-]+$/.test(entry.tag)) {
    throw new Error(`Invalid or out-of-order Drizzle migration journal entry: ${entry.tag}.`);
  }
  previousWhen = entry.when;

  const date = new Date(entry.when);
  const version = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0"),
  ].join("");
  const filename = `${version}_${entry.tag}.sql`;
  const source = join(sourceDirectory, `${entry.tag}.sql`);
  const target = join(targetDirectory, filename);

  await readFile(source);
  expectedFiles.add(filename);
  await copyFile(source, target);
}

const unexpectedFiles = (await readdir(targetDirectory)).filter(
  (filename) => filename.endsWith(".sql") && !expectedFiles.has(filename),
);
if (unexpectedFiles.length > 0) {
  throw new Error(`Unexpected Supabase migration files: ${unexpectedFiles.join(", ")}`);
}

console.log(`Synced ${expectedFiles.size} migrations from drizzle/migrations to supabase/migrations.`);
