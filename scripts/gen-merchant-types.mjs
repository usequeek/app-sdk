#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * Refresh the Merchant API contract snapshot and regenerate the typed schema.
 *
 * Usage:
 *   pnpm gen:merchant [url-or-path]
 *
 * Defaults to the live public contract
 * (https://api.usequeek.com/docs/merchant.json). Before the merchant-naming
 * slice deploys, live is STALE (old /api/v1/biz paths) — generate from a
 * local backend instead:
 *
 *   php artisan serve --port=18923   # in queek_backend
 *   pnpm gen:merchant http://127.0.0.1:18923/docs/merchant.json
 *
 * Inputs:  openapi/merchant.json (committed snapshot, the reviewed contract)
 * Outputs: src/merchant-schema.ts (committed generated types)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = join(root, "openapi", "merchant.json");
const schemaPath = join(root, "src", "merchant-schema.ts");

const source = process.argv[2] ?? "https://api.usequeek.com/docs/merchant.json";

let specText;
if (/^https?:\/\//.test(source)) {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Could not fetch Merchant API spec: ${response.status} ${source}`);
  specText = await response.text();
} else {
  specText = readFileSync(source, "utf8");
}

// Fail loudly on HTML error pages, not on JSON — a login wall must never
// silently become the committed contract.
const spec = JSON.parse(specText);
if (spec.openapi !== "3.1.0" || typeof spec.paths !== "object" || !spec.paths["/store"]) {
  throw new Error(
    "Spec sanity check failed: expected OpenAPI 3.1.0 with a /store path (is merchant-naming deployed at this URL?).",
  );
}
writeFileSync(snapshotPath, `${JSON.stringify(spec, null, 2)}\n`);
console.log(`snapshot: ${snapshotPath} (${Object.keys(spec.paths).length} paths)`);

const gen = spawnSync("npx", ["openapi-typescript", snapshotPath, "-o", schemaPath], {
  stdio: "inherit",
  cwd: root,
});
if (gen.status !== 0) throw new Error("openapi-typescript failed.");

const provenance =
  `/**\n` +
  ` * GENERATED from openapi/merchant.json — do not edit by hand.\n` +
  ` * Refresh with: pnpm --filter @queek/app-sdk gen:merchant [url-or-path]\n` +
  ` * See scripts/gen-merchant-types.mjs for source precedence.\n` +
  ` */\n`;
writeFileSync(schemaPath, provenance + readFileSync(schemaPath, "utf8"));
console.log(`schema: ${schemaPath}`);
