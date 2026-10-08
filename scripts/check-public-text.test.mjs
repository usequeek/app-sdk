import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "check-public-text.mjs");

// Leaky strings are assembled at run time so this file stays clean itself.
const word = (...parts) => parts.join("");
const LEAKS = {
  "internal-repo": word("queek", "_", "back", "end", " config"),
  "internal-dir": word(".ag", "ent/", "notes"),
  "internal-host": word("deployed via ", "Dok", "ploy"),
  "internal-person": word("the ", "found", "er decided"),
  "local-path": word("/Us", "ers/", "someone/project"),
  "rendering-bug": word("[object ", "Object]"),
  "plan-id": word("plan ", "T2"),
  "decision-id": word("decision ", "4"),
};
const FAKE_KEY = word("sk", "_", "test", "_", "A1b2C3d4E5f6G7h8");

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "public-text-"));
  execFileSync("git", ["init", "-q", dir]);
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

const run = (dir) => spawnSync("node", [script, dir], { encoding: "utf8" });

test("clean repository passes", () => {
  const dir = repo({ "README.md": "# Hello\n\nUse /users/me to read the profile.\n" });
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  rmSync(dir, { recursive: true });
});

test("each internal reference fails with file:line and the rule id", () => {
  for (const [rule, text] of Object.entries(LEAKS)) {
    const dir = repo({ "docs/a.md": `fine\n${text}\n` });
    const result = run(dir);
    assert.equal(result.status, 1, `${rule} should fail`);
    assert.match(result.stderr, new RegExp(`docs/a\\.md:2  \\[${rule}\\]`), rule);
    rmSync(dir, { recursive: true });
  }
});

test("secret-shaped strings fail without echoing the value", () => {
  const dir = repo({ ".env.example": `KEY=${FAKE_KEY}\n` });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.env\.example:1  \[secret-key\]  \(value hidden\)/);
  assert.ok(!result.stderr.includes(FAKE_KEY), "the value is never printed");
  rmSync(dir, { recursive: true });
});

test("a justified allow-list entry suppresses one rule for one path", () => {
  const dir = repo({
    "tests/fixtures/key.txt": `${word("-----BEGIN ", "PRIVATE KEY-----")}\n`,
    ".public-text-allow": "tests/fixtures/ | private-key | throwaway fixture, not a real key\n",
  });
  assert.equal(run(dir).status, 0);
  writeFileSync(join(dir, "tests/fixtures/other.txt"), `${LEAKS["internal-person"]}\n`);
  assert.equal(run(dir).status, 1, "other rules still apply under the allowed path");
  rmSync(dir, { recursive: true });
});

test("an allow-list entry without a reason is rejected", () => {
  const dir = repo({ "a.md": "ok\n", ".public-text-allow": "a.md | private-key |\n" });
  const result = run(dir);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /expected "path \| rule-id \| reason"/);
  rmSync(dir, { recursive: true });
});

test("lockfiles, node_modules and binary files are skipped", () => {
  const dir = repo({
    "package-lock.json": `${LEAKS["internal-repo"]}\n`,
    "node_modules/x/index.js": `${LEAKS["internal-repo"]}\n`,
  });
  writeFileSync(join(dir, "image.bin"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(LEAKS["internal-repo"])]));
  assert.equal(run(dir).status, 0);
  rmSync(dir, { recursive: true });
});
