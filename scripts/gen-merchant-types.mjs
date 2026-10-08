#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * Refresh the Merchant API contract snapshot and regenerate the typed schema.
 *
 * Usage:
 *   npm run gen:merchant [url-or-path]
 *
 * With no argument the snapshot is pulled from the live spec at
 * https://api.usequeek.com/docs/merchant.json. Pass a URL or a local file
 * path to generate from another copy of the Merchant API spec instead:
 *
 *   npm run gen:merchant ./merchant.json
 *
 * Always diff the snapshot before committing.
 *
 * Inputs:  openapi/merchant.json (committed snapshot of the Merchant API contract)
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
// spec (paths are relative to /api/v1/merchant): the import op the SDK
// depends on must exist.
const spec = JSON.parse(specText);
if (spec.openapi !== "3.1.0" || typeof spec.paths !== "object" || !spec.paths["/orders/import"]) {
  throw new Error(
    "Spec sanity check failed: expected the Merchant API spec (OpenAPI 3.1.0 with an /orders/import path), as served at https://api.usequeek.com/docs/merchant.json.",
  );
}
// A spec exported from a local server points `servers` at localhost — the
// committed contract is the Merchant API at its public base, so normalize
// that one field (paths and schemas are untouched).
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
  ` * Refresh with: npm run gen:merchant [url-or-path]\n` +
  ` * See scripts/gen-merchant-types.mjs for source precedence.\n` +
  ` */\n`;
writeFileSync(schemaPath, provenance + readFileSync(schemaPath, "utf8"));
console.log(`schema: ${schemaPath}`);
