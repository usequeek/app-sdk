#!/usr/bin/env node
/**
 * Consumes the SDK the way an OUTSIDER does, from a packed tarball.
 *
 * Packs the CURRENT SOURCE (not the registry) and proves two things in
 * two sandboxes:
 *
 * A. WITHOUT `hono` installed: `import "@usequeek/app-sdk"` works and the
 *    framework-agnostic core (`handleInstallRequest` /
 *    `handleWebhookRequest` with plain `new Request(...)`) serves the
 *    install handoff + webhook dispatch, plus the `./server`
 *    session-verifier export loads. Importing `@usequeek/app-sdk/hono`
 *    MUST fail here — that is the proof the root entry carries zero
 *    framework imports.
 * B. WITH `hono` installed: `@usequeek/app-sdk/hono` serves the same
 *    handoff + webhooks through the thin Hono wrappers.
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

function pack() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  console.log(`verify-package: packing ${pkg.name}@${pkg.version} and consuming it as an outsider`);
  run("npm", ["run", "build"], ROOT);
  const staging = mkdtempSync(join(tmpdir(), "sdk-pack-"));
  try {
    run("npm", ["pack", "--pack-destination", staging], ROOT);
    const tarball = readdirSync(staging).find((f) => f.endsWith(".tgz"));
    if (!tarball) throw new Error("npm pack produced no tarball");
    return { pkg, tarballPath: join(staging, tarball) };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Sandbox A: the SDK with NO `hono` anywhere — the root entry must stand alone. */
const CORE_EXAMPLE = `import { randomBytes } from "node:crypto";
import {
  handleInstallRequest,
  handleWebhookRequest,
  signQueekPayload,
  SqliteInstallationStore,
  verifyQueekSignature,
} from "@usequeek/app-sdk";
import { verifySessionToken } from "@usequeek/app-sdk/server";

const APP_SECRET = "whsec_YXBwc2lnbmluZ3NlY3JldEFwcHNlY3JldA";
const NOW = Math.floor(Date.now() / 1000);
const store = new SqliteInstallationStore({
  path: ":memory:",
  storeKey: randomBytes(32).toString("base64"),
});
if (typeof verifyQueekSignature !== "function") throw new Error("missing verifyQueekSignature");
if (typeof verifySessionToken !== "function") throw new Error("missing verifySessionToken/server export");

function signedHeaders(eventId, timestamp, rawBody, secret) {
  return {
    "webhook-id": eventId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signQueekPayload(eventId, timestamp, rawBody, secret),
  };
}
function webRequest(path, body, headers) {
  const plain = {};
  for (const [k, v] of Object.entries(headers)) plain[k] = v;
  return new Request("http://localhost" + path, { method: "POST", headers: plain, body });
}

const webhookSecret = "whsec_" + randomBytes(24).toString("base64");
const installBody = JSON.stringify({
  id: "evt-install-1",
  type: "app/installed",
  api_version: "v1",
  created_at: "2026-09-24T00:00:00+00:00",
  data: {
    installation: { id: "11111111-1111-1111-1111-111111111111", p_id: "inst_abc123" },
    store: {
      id: "22222222-2222-2222-2222-222222222222",
      p_id: "store_xyz",
      name: "Test Store",
      is_test: true,
    },
    api_base: "https://api.usequeek.com/api/v1/merchant",
    scopes: ["merchant-business_profile-read"],
    settings: {},
    webhook_secret: webhookSecret,
    proxy_secret: "whsec_" + randomBytes(24).toString("base64"),
    webhook_url: "https://hello.apps.usequeek.com/webhooks",
    webhook_topics: ["orders/updated"],
  },
});
const installRes = await handleInstallRequest(
  webRequest("/install", installBody, signedHeaders("evt-install-1", NOW, installBody, APP_SECRET)),
  { appSecret: APP_SECRET, store },
);
if (installRes.status !== 200) throw new Error("install handoff failed: " + installRes.status);
const stored = await store.getInstallation("11111111-1111-1111-1111-111111111111");
if (!stored || stored.webhookSecret !== webhookSecret) throw new Error("installation was not stored");

const delivery = JSON.stringify({
  id: "evt-1",
  topic: "orders/updated",
  api_version: "v1",
  created_at: "2026-09-24T00:00:00+00:00",
  data: { order: { id: "order-1" } },
});
let seen = 0;
const webhookRes = await handleWebhookRequest(
  webRequest(
    "/webhooks",
    delivery,
    { ...signedHeaders("evt-1", NOW, delivery, webhookSecret), "X-Queek-Topic": "orders/updated" },
  ),
  { store, handlers: { "orders/updated": async () => { seen += 1; } } },
);
if (webhookRes.status !== 200) throw new Error("webhook dispatch failed: " + webhookRes.status);
if (seen !== 1) throw new Error("webhook handler did not run");

// The Hono subpath MUST NOT load here: no hono is installed, and the root
// entry must not need it.
let honoFailed = false;
try {
  await import("@usequeek/app-sdk/hono");
} catch {
  honoFailed = true;
}
if (!honoFailed) throw new Error("@usequeek/app-sdk/hono loaded without hono installed");
console.log("core ok: install handoff + webhook dispatch with plain Request, no hono");
`;

/** Sandbox B: WITH `hono` — the thin wrappers serve the same handoff + webhooks. */
const HONO_EXAMPLE = `import { randomBytes } from "node:crypto";
import { SqliteInstallationStore, signQueekPayload } from "@usequeek/app-sdk";
import { createInstallHandlers, createWebhookHandler } from "@usequeek/app-sdk/hono";
import { Hono } from "hono";

const APP_SECRET = "whsec_YXBwc2lnbmluZ3NlY3JldEFwcHNlY3JldA";
const NOW = Math.floor(Date.now() / 1000);
const store = new SqliteInstallationStore({
  path: ":memory:",
  storeKey: randomBytes(32).toString("base64"),
});
function signedHeaders(eventId, timestamp, rawBody, secret) {
  return {
    "webhook-id": eventId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signQueekPayload(eventId, timestamp, rawBody, secret),
  };
}

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));
app.route("/", createInstallHandlers({ appSecret: APP_SECRET, store }));
app.route("/webhooks", createWebhookHandler({ store, handlers: {} }));

const res = await app.request("/health");
if (res.status !== 200) throw new Error("health check failed");
const body = await res.json();
if (body.ok !== true) throw new Error("health body wrong");

const webhookSecret = "whsec_" + randomBytes(24).toString("base64");
const installBody = JSON.stringify({
  id: "evt-install-1",
  type: "app/installed",
  api_version: "v1",
  created_at: "2026-09-24T00:00:00+00:00",
  data: {
    installation: { id: "11111111-1111-1111-1111-111111111111", p_id: "inst_abc123" },
    store: {
      id: "22222222-2222-2222-2222-222222222222",
      p_id: "store_xyz",
      name: "Test Store",
      is_test: true,
    },
    api_base: "https://api.usequeek.com/api/v1/merchant",
    scopes: ["merchant-business_profile-read"],
    settings: {},
    webhook_secret: webhookSecret,
    proxy_secret: "whsec_" + randomBytes(24).toString("base64"),
    webhook_url: "https://hello.apps.usequeek.com/webhooks",
    webhook_topics: ["orders/updated"],
  },
});
const installRes = await app.request("/install", {
  method: "POST",
  headers: signedHeaders("evt-install-1", NOW, installBody, APP_SECRET),
  body: installBody,
});
if (installRes.status !== 200) throw new Error("hono install handoff failed: " + installRes.status);

const delivery = JSON.stringify({
  id: "evt-1",
  topic: "orders/updated",
  api_version: "v1",
  created_at: "2026-09-24T00:00:00+00:00",
  data: {},
});
const webhookRes = await app.request("/webhooks", {
  method: "POST",
  headers: signedHeaders("evt-1", NOW, delivery, webhookSecret),
  body: delivery,
});
if (webhookRes.status !== 200) throw new Error("hono webhook dispatch failed: " + webhookRes.status);
console.log("hono ok: install handlers + webhooks via /hono wrappers");
`;

function sandbox(pkgName, tarballPath, withHono, exampleSource) {
  const dir = mkdtempSync(join(tmpdir(), withHono ? "sdk-consumer-hono-" : "sdk-consumer-core-"));
  try {
    const dependencies = { [pkgName]: `file:${tarballPath}` };
    if (withHono) dependencies.hono = "^4";
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        { name: "sdk-consumer", private: true, version: "1.0.0", type: "module", dependencies },
        null,
        2,
      ),
    );
    console.log(`verify-package: installing from the tarball (${withHono ? "with" : "without"} hono)…`);
    run("npm", ["install", "--no-audit", "--no-fund"], dir);
    writeFileSync(join(dir, "example.mjs"), exampleSource);
    const out = run("node", ["example.mjs"], dir);
    console.log(out.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const { pkg, tarballPath } = pack();
  try {
    sandbox(pkg.name, tarballPath, false, CORE_EXAMPLE);
    sandbox(pkg.name, tarballPath, true, HONO_EXAMPLE);
    console.log("verify-package: outsider consumer passed (core without hono, wrappers with hono)");
  } finally {
    rmSync(join(tarballPath, ".."), { recursive: true, force: true });
  }
}

main();
