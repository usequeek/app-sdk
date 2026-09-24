#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * Refresh the Merchant API contract snapshot and regenerate the typed schema.
 *
 * Usage:
 *   pnpm gen:merchant [url-or-path]
 *
 * Source precedence (A3b, 2026-09-24): the backend's merchant-scoped spec at
 * the reviewed commit, exported WITHOUT a server via Scramble —
 *
 *   php artisan scramble:export --api=merchant --path=/tmp/merchant.json  # in queek_backend
 *   pnpm gen:merchant /tmp/merchant.json
 *
 * — NOT production (production is behind until the A3b backend deploys, so
 * the live https://api.usequeek.com/docs/merchant.json is STALE for the
 * import v2 contract). After the backend deploy, re-run against production
 * and diff: the snapshot MUST be re-checked, then this comment updated.
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
// silently become the committed contract. The check pins the merchant-scoped
// export (Scramble `--api=merchant` strips the /api/v1/merchant prefix, so
// paths are scope-relative): the import op the SDK depends on must exist.
const spec = JSON.parse(specText);
if (spec.openapi !== "3.1.0" || typeof spec.paths !== "object" || !spec.paths["/orders/import"]) {
  throw new Error(
    "Spec sanity check failed: expected OpenAPI 3.1.0 with an /orders/import path (export with `php artisan scramble:export --api=merchant`).",
  );
}
// A local Scramble export points `servers` at localhost — the reviewed
// contract is the Merchant API at its public base, so normalize that one
// field (paths and schemas are untouched).
spec.servers = [{ url: "https://api.usequeek.com/api/v1/merchant", description: "Current" }];
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
