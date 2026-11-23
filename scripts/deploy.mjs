import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const localBinary = (name) => `node_modules/.bin/${name}`;
function run(binary, args) {
  const result = spawnSync(binary, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

const required = [
  "CLOUDFLARE_D1_DATABASE_ID",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUD",
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
if (
  !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\/?$/.test(
    process.env.ACCESS_TEAM_DOMAIN,
  )
)
  throw new Error(
    "ACCESS_TEAM_DOMAIN must be your https://TEAM.cloudflareaccess.com URL.",
  );
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.OWNER_EMAIL))
  throw new Error("Set your allowed login email.");
if (
  !process.argv.includes("--check") &&
  process.env.BOOXS_ACCESS_CONFIGURED !== "true"
) {
  console.error(
    "Configure Cloudflare Access for the production hostname before deployment, then set BOOXS_ACCESS_CONFIGURED=true. The API also rejects unauthenticated requests. See README.md.",
  );
  process.exit(1);
}
// The base config deliberately has no comments, so it remains safe to parse as JSON.
const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
delete config.env;
config.d1_databases[0].database_id = process.env.CLOUDFLARE_D1_DATABASE_ID;
config.vars = Object.fromEntries(
  ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "OWNER_EMAIL"].map((key) => [
    key,
    process.env[key].replace(/\/$/, ""),
  ]),
);
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
}
