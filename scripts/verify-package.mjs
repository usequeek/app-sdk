#!/usr/bin/env node
/**
 * Consumes the SDK the way an OUTSIDER does, from a packed tarball.
 *
 * Packs the CURRENT SOURCE (not the registry), installs it in a sandbox
 * with its peer (`hono`), and runs the README example shape against the
 * built `dist`: sqlite store + install handlers + webhook dispatch +
 * `./server` session-verifier export.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args, cwd, extraEnv) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(extraEnv ?? {}) },
  });
}

function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  console.log(`verify-package: packing ${pkg.name}@${pkg.version} and consuming it as an outsider`);
  run("npm", ["run", "build"], ROOT);
  const sandbox = mkdtempSync(join(tmpdir(), "sdk-consumer-"));
  try {
    run("npm", ["pack", "--pack-destination", sandbox], ROOT);
    const tarball = readdirSync(sandbox).find((f) => f.endsWith(".tgz"));
    if (!tarball) throw new Error("npm pack produced no tarball");

    writeFileSync(
      join(sandbox, "package.json"),
      JSON.stringify(
        {
          name: "sdk-consumer",
          private: true,
          version: "1.0.0",
          type: "module",
          dependencies: { [pkg.name]: `file:./${tarball}`, hono: "^4" },
        },
        null,
        2,
      ),
    );
    console.log("verify-package: installing from the tarball…");
    run("npm", ["install", "--no-audit", "--no-fund"], sandbox);

    writeFileSync(
      join(sandbox, "example.mjs"),
      `import { randomBytes } from "node:crypto";
import {
  createInstallHandlers,
  createWebhookHandler,
  SqliteInstallationStore,
  verifyQueekSignature,
} from "@usequeek/app-sdk";
import { verifySessionToken } from "@usequeek/app-sdk/server";
import { Hono } from "hono";

const store = new SqliteInstallationStore({
  path: ":memory:",
  storeKey: randomBytes(32).toString("base64"),
});
if (typeof verifyQueekSignature !== "function") throw new Error("missing verifyQueekSignature");
if (typeof verifySessionToken !== "function") throw new Error("missing verifySessionToken/server export");

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));
app.route("/", createInstallHandlers({ appSecret: "whsec_test", store }));
app.route("/webhooks", createWebhookHandler({ store, handlers: {} }));

const res = await app.request("/health");
if (res.status !== 200) throw new Error("health check failed");
const body = await res.json();
if (body.ok !== true) throw new Error("health body wrong");
console.log("example ok: install handlers + webhooks + server export load");
`,
    );
    const out = run("node", ["example.mjs"], sandbox);
    console.log(out.trim());
    console.log("verify-package: outsider consumer passed");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

main();
