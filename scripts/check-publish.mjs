#!/usr/bin/env node
/**
 * Pre-publish guard for @usequeek/app-sdk. Run locally
 * (`npm run check:publish`) and in CI before every
 * publish: `npm pack --dry-run` must list ONLY the intended files, and the
 * packed contents must hold no secret VALUES, no `.agent-` files, and no
 * non-public hostnames.
 *
 * Secret detection is value-shaped ON PURPOSE: the SDK legitimately
 * MENTIONS key shapes (`sk_…` in docs, `SECRET_PREFIX = "whsec_"`, the
 * logger's redaction regex). Placeholders ship; only real-looking values
 * fail — `sk_live_/sk_test_` + 8 chars, `whsec_` + 8 chars, `ghp_` /
 * `github_pat_` tokens, PEM blocks. Likewise `.agent-` is checked against
 * packed FILE paths (brief files live at the repo root and must never be
 * packed), and hostnames fail only when internal (localhost, IPs,
 * .test/.local, tunnels) or a non-public usequeek host: api.usequeek.com,
 * docs.usequeek.com (backend-generated descriptions link it),
 * apps.usequeek.com + *.apps.usequeek.com, and media.usequeek.com (public
 * media CDN examples inside openapi/merchant.json) may appear; public links
 * (github.com, npmjs.com) are fine.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWED_FILES = new Set(["package.json", "openapi/merchant.json", "README.md", "LICENSE"]);
function allowedFile(path) {
  return ALLOWED_FILES.has(path) || path.startsWith("dist/");
}

// Real secret VALUES (see header: mentions/placeholders don't match).
const SECRET_RES = [
  /\bsk_(live|test)_[A-Za-z0-9_-]{8,}/,
  /\bwhsec_[A-Za-z0-9+/=_-]{8,}/,
  /\bghp_[A-Za-z0-9]{8,}/,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/,
  /-----BEGIN [A-Z ]+-----/,
];

function hostsIn(text) {
  const hosts = new Set();
  for (const m of text.matchAll(/https?:\/\/([^/:?\s#]+)/gi)) hosts.add(m[1].toLowerCase());
  for (const m of text.matchAll(/(?<![a-z0-9.-])([a-z0-9-]+\.usequeek\.com)/gi)) {
    hosts.add(m[1].toLowerCase());
  }
  return hosts;
}

function badHost(host) {
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(host)) return "internal";
  if (/\.(test|local|internal|lan|home)(\.|$)/.test(host)) return "internal";
  if (/(ngrok|herd|tunnel)/.test(host)) return "tunnel/dev";
  if (host.endsWith(".usequeek.com")) {
    if (host === "api.usequeek.com" || host === "docs.usequeek.com") return null;
    if (host === "apps.usequeek.com" || host.endsWith(".apps.usequeek.com")) return null;
    if (host === "media.usequeek.com") return null;
    return "non-public usequeek host";
  }
  return null;
}

const failures = [];
let packed;
try {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" });
  const parsed = JSON.parse(out);
  // npm 10 wraps the list as [{ files: [...] }]; newer npm emits the flat array.
  packed = Array.isArray(parsed) && parsed.length > 0 && !parsed[0].path ? parsed[0].files : parsed;
  if (!Array.isArray(packed) || packed.some((e) => typeof e?.path !== "string")) {
    throw new Error("unexpected npm output");
  }
} catch (error) {
  console.error(`error: npm pack --dry-run failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

for (const entry of packed) {
  const path = entry.path;
  if (path.includes(".agent-")) failures.push(`packed path looks like a brief file: ${path}`);
  if (!allowedFile(path)) {
    failures.push(`unexpected packed file: ${path}`);
    continue;
  }
  let text;
  try {
    text = readFileSync(join(root, path), "utf8");
  } catch {
    continue; // Binary or unreadable as text: file-list check already passed.
  }
  for (const re of SECRET_RES) {
    const m = re.exec(text);
    if (m) {
      failures.push(`secret-looking value in ${path}: ${re} (…${m[0].slice(0, 24)}…)`);
      break;
    }
  }
  for (const host of hostsIn(text)) {
    const reason = badHost(host);
    if (reason) failures.push(`bad hostname in ${path}: ${host} (${reason})`);
  }
}

// Sanity: the tarball must not be empty shell — dist must carry the entry points.
const names = packed.map((e) => e.path);
for (const must of ["package.json", "dist/index.js", "dist/index.d.ts"]) {
  if (!names.includes(must)) failures.push(`missing expected packed file: ${must}`);
}

if (failures.length > 0) {
  console.error("error: pre-publish guard failed:");
  for (const f of failures.slice(0, 20)) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`pre-publish guard passed (${packed.length} packed files, no secrets, no bad hosts).`);
