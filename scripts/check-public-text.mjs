#!/usr/bin/env node
// Public-text guard: fails when a tracked text file carries an internal
// reference or a secret-shaped string. Zero dependencies.
//
//   node scripts/check-public-text.mjs [repo-dir]
//
// Exit 0 = clean, 1 = findings, 2 = bad usage or a bad allow-list.
//
// Intentional exceptions live in `.public-text-allow`, one per line:
//
//   path/to/file | rule-id | reason
//
// `path` is an exact file path, or a directory prefix ending in `/`.
// Every entry needs a reason. Lines starting with `#` are comments.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// Character classes keep this file from matching its own patterns.
export const RULES = [
  { id: "internal-repo", re: /queek[_-]backend/i },
  { id: "internal-dir", re: /[.]agent\//i },
  { id: "internal-tasks", re: /TASK[S]\// },
  { id: "internal-plan-doc", re: /app-ui-ki[t]/i },
  { id: "internal-host", re: /Dokplo[y]|GHC[R]/i },
  { id: "internal-person", re: /found[e]r/i },
  { id: "local-path", re: /\/User[s]\/[A-Za-z]/ },
  { id: "rendering-bug", re: /\[object Objec[t]\]/i },
  { id: "plan-id", re: /plan T[0-9]/i },
  { id: "decision-id", re: /decision [0-9]+/i },
  { id: "secret-key", re: /sk_(live|test)_[A-Za-z0-9]{10,}/i, secret: true },
  { id: "github-token", re: /ghp_[A-Za-z0-9]{20,}/i, secret: true },
  { id: "private-key", re: /BEGIN [A-Z ]*PRIVATE KEY/i, secret: true },
];

const SKIP_NAMES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "composer.lock"]);
const MAX_BYTES = 5 * 1024 * 1024;

export function loadAllowList(root) {
  const file = join(root, ".public-text-allow");
  if (!existsSync(file)) return { entries: [], errors: [] };
  const entries = [];
  const errors = [];
  readFileSync(file, "utf8").split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const [path, rule, ...reason] = line.split("|").map((part) => part.trim());
    if (!path || !rule || !reason.join("|").trim()) {
      errors.push(`.public-text-allow:${i + 1}: expected "path | rule-id | reason"`);
    } else if (!RULES.some((r) => r.id === rule)) {
      errors.push(`.public-text-allow:${i + 1}: unknown rule "${rule}"`);
    } else {
      entries.push({ path, rule });
    }
  });
  return { entries, errors };
}

const isAllowed = (entries, file, rule) =>
  entries.some((e) => e.rule === rule && (e.path === file || (e.path.endsWith("/") && file.startsWith(e.path))));

export function scan(root) {
  const listed = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const { entries, errors } = loadAllowList(root);
  const findings = [];
  for (const file of [...new Set(listed.split("\0").filter(Boolean))]) {
    const name = file.split("/").pop();
    if (SKIP_NAMES.has(name) || file.split("/").includes("node_modules")) continue;
    const full = join(root, file);
    let body;
    try {
      if (!statSync(full).isFile() || statSync(full).size > MAX_BYTES) continue;
      const buf = readFileSync(full);
      if (buf.subarray(0, 8000).includes(0)) continue;
      body = buf.toString("utf8");
    } catch {
      continue;
    }
    body.split("\n").forEach((text, i) => {
      for (const rule of RULES) {
        if (rule.re.test(text) && !isAllowed(entries, file, rule.id)) {
          findings.push({ file, line: i + 1, rule: rule.id, text: rule.secret ? null : text.trim().slice(0, 100) });
        }
      }
    });
  }
  return { findings, errors };
}

function main() {
  const root = resolve(process.argv[2] ?? ".");
  let result;
  try {
    result = scan(root);
  } catch (error) {
    console.error(`check-public-text: cannot list files in ${root}: ${error.message}`);
    return 2;
  }
  if (result.errors.length) {
    for (const e of result.errors) console.error(e);
    return 2;
  }
  for (const f of result.findings) {
    console.error(`${f.file}:${f.line}  [${f.rule}]${f.text ? `  ${f.text}` : "  (value hidden)"}`);
  }
  if (result.findings.length) {
    console.error(`check-public-text: ${result.findings.length} finding(s). Fix the text, or add a justified entry to .public-text-allow.`);
    return 1;
  }
  console.log("check-public-text: clean");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
