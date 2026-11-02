import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const source = resolve("dist");
const target = resolve(process.env.VERCEL ? ".vercel/output/static" : ".output/public");
const worker = join(source, "sw.js");
const workerSource = await readFile(worker, "utf8");
const sourceFiles = await readdir(source);
const workboxFiles = [
  ...new Set(
    [...workerSource.matchAll(/["']\.\/(workbox-[\w-]+)(?:\.js)?["']/g)].map(
      (match) => `${match[1]}.js`,
    ),
  ),
];

if (workboxFiles.length === 0) {
  throw new Error("VitePWA did not generate the Workbox runtime required by sw.js.");
}

await mkdir(target, { recursive: true });
await copyFile(worker, join(target, "sw.js"));
for (const name of workboxFiles) {
  if (!sourceFiles.includes(name)) {
    throw new Error(`Generated service worker references missing Workbox runtime ${name}.`);
  }
  await copyFile(join(source, name), join(target, name));
}
