import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFile } from "node:fs/promises";

async function loadEnvironment() {
  const values = { ...process.env };
  try {
    const contents = await readFile(new URL("../.env", import.meta.url), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && values[match[1]] === undefined) {
        values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return values;
}

function askHidden(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error(
      "Run this command in an interactive terminal so the password can be entered privately.",
    );
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("Cancelled."));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    };
    stdin.on("data", onData);
  });
}

const env = await loadEnvironment();
const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error(
    "Set SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY before bootstrapping.",
  );
}

const terminal = createInterface({ input: stdin, output: stdout });
const email = (await terminal.question("Initial owner email: ")).trim();
const fullName = (await terminal.question("Initial owner name: ")).trim();
terminal.close();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid owner email.");
if (!fullName) throw new Error("Owner name is required.");

const password = await askHidden("Owner password (minimum 12 characters): ");
const confirmation = await askHidden("Confirm owner password: ");
if (password.length < 12) throw new Error("Use a unique passphrase of at least 12 characters.");
if (password !== confirmation) throw new Error("Passwords do not match.");

const response = await fetch(`${url.replace(/\/+$/, "")}/auth/v1/admin/users`, {
  method: "POST",
  headers: {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
    app_metadata: { provisioning: "initial_owner" },
  }),
});

if (!response.ok) {
  if (response.status === 422)
    throw new Error("The account could not be created. Check whether this email already exists.");
  throw new Error(
    `Owner provisioning failed (HTTP ${response.status}). Verify the project and server key, then inspect Supabase Auth logs.`,
  );
}

console.log(
  "Initial Owner provisioned. Keep public sign-up disabled and store the password securely.",
);
