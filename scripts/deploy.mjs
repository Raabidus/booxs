import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parsePasswordHash } from "../shared/password.ts";

const localBinary = (name) => `node_modules/.bin/${name}`;
function run(binary, args, input) {
  const result = spawnSync(binary, args, {
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    input,
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

const required = [
  "CLOUDFLARE_D1_DATABASE_ID",
  "OWNER_PASSWORD_HASH",
  "OWNER_EMAIL",
];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(
    `Missing deployment settings: ${missing.join(", ")}. See README.md → Cloudflare deployment.`,
  );
  process.exit(1);
}
if (
  !/^[a-f0-9-]{36}$/i.test(process.env.CLOUDFLARE_D1_DATABASE_ID) ||
  process.env.CLOUDFLARE_D1_DATABASE_ID ===
    "00000000-0000-0000-0000-000000000000"
)
  throw new Error("Set a real D1 database UUID.");
if (!parsePasswordHash(process.env.OWNER_PASSWORD_HASH))
  throw new Error("Generate OWNER_PASSWORD_HASH with npm run auth:password.");
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.OWNER_EMAIL))
  throw new Error("Set your allowed login email.");
// The base config deliberately has no comments, so it remains safe to parse as JSON.
const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
delete config.env;
config.d1_databases[0].database_id = process.env.CLOUDFLARE_D1_DATABASE_ID;
config.vars = { OWNER_EMAIL: process.env.OWNER_EMAIL.trim().toLowerCase() };
await writeFile(
  "wrangler.production.json",
  JSON.stringify(config, null, 2) + "\n",
);
run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"]);
run(process.execPath, ["scripts/build.mjs"]);
if (process.argv.includes("--check")) {
  run(localBinary("wrangler"), [
    "deploy",
    "--config",
    "wrangler.production.json",
    "--dry-run",
    "--outdir",
    ".wrangler/deploy-check",
  ]);
} else {
  run(localBinary("wrangler"), [
    "d1",
    "migrations",
    "apply",
    "booxs",
    "--remote",
    "--config",
    "wrangler.production.json",
  ]);
  run(localBinary("wrangler"), [
    "deploy",
    "--config",
    "wrangler.production.json",
  ]);
  // Credentials travel only on stdin into Wrangler's encrypted secret storage.
  // A first deployment rejects all private API requests until this is present.
  run(
    localBinary("wrangler"),
    ["secret", "bulk", "--config", "wrangler.production.json"],
    JSON.stringify({ OWNER_PASSWORD_HASH: process.env.OWNER_PASSWORD_HASH }),
  );
}
