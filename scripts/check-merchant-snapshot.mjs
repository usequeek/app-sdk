#!/usr/bin/env node
/**
 * Fail when the committed Merchant API snapshot drifts from the live
 * contract — refresh with `pnpm --filter @usequeek/app-sdk gen:merchant`
 * before an SDK release, then commit both files.
 *
 * A NETWORK failure is a WARNING, not a failure (exit 0), so CI stays
 * green offline: only a real contract diff fails the check.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = join(root, "openapi", "merchant.json");
const LIVE_URL = "https://api.usequeek.com/docs/merchant.json";

function warn(message) {
  // GitHub Actions annotation when running in CI, plain text locally.
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::warning::${message}`);
  else console.warn(`warning: ${message}`);
}

/** Canonical form: servers normalised exactly like gen-merchant-types.mjs, keys sorted. */
function canonical(spec) {
  const copy = JSON.parse(JSON.stringify(spec));
  copy.servers = [{ url: "https://api.usequeek.com/api/v1/merchant", description: "Current" }];
  return JSON.stringify(sortDeep(copy));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortDeep(value[k])]),
    );
  }
  return value;
}

function diffSummary(live, snap) {
  const lines = [];
  const livePaths = live.paths ?? {};
  const snapPaths = snap.paths ?? {};
  for (const p of Object.keys(livePaths).sort()) {
    if (!(p in snapPaths)) lines.push(`path only live: ${p}`);
    else if (JSON.stringify(sortDeep(livePaths[p])) !== JSON.stringify(sortDeep(snapPaths[p]))) {
      lines.push(`changed path: ${p}`);
    }
  }
  for (const p of Object.keys(snapPaths).sort()) {
    if (!(p in livePaths)) lines.push(`path only snapshot: ${p}`);
  }
  const liveSchemas = live.components?.schemas ?? {};
  const snapSchemas = snap.components?.schemas ?? {};
  for (const s of Object.keys(liveSchemas).sort()) {
    if (!(s in snapSchemas)) lines.push(`schema only live: ${s}`);
    else if (JSON.stringify(sortDeep(liveSchemas[s])) !== JSON.stringify(sortDeep(snapSchemas[s]))) {
      lines.push(`changed schema: ${s}`);
    }
  }
  for (const s of Object.keys(snapSchemas).sort()) {
    if (!(s in liveSchemas)) lines.push(`schema only snapshot: ${s}`);
  }
  return lines;
}

let liveText;
try {
  const response = await fetch(LIVE_URL, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  liveText = await response.text();
} catch (error) {
  warn(
    `could not fetch the live Merchant API spec (${error instanceof Error ? error.message : error}); skipping the snapshot check.`,
  );
  process.exit(0);
}

let live;
try {
  live = JSON.parse(liveText);
} catch {
  warn("the live Merchant API spec did not parse as JSON; skipping the snapshot check.");
  process.exit(0);
}

const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
if (canonical(live) === canonical(snapshot)) {
  console.log("merchant snapshot matches the live contract.");
  process.exit(0);
}

console.error(`error: ${snapshotPath} differs from ${LIVE_URL}.`);
for (const line of diffSummary(live, snapshot).slice(0, 20)) console.error(`  ${line}`);
console.error("Refresh with: pnpm --filter @usequeek/app-sdk gen:merchant");
process.exit(1);
