#!/usr/bin/env node
/**
 * Consumes the SDK the way an OUTSIDER does, from a packed tarball.
 *
 * Packs the CURRENT SOURCE (not the registry) and proves four things in
 * four sandboxes:
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
 * C. WITH `react` installed: `@usequeek/app-sdk/react` resolves and renders
 *    once via `react-dom/server`.
 * D. WITHOUT any framework: `@usequeek/app-sdk/browser` loads in a DOM-free
 *    runtime AND bundles cleanly with esbuild (`platform=browser`, no node
 *    polyfills): the bundle must build and must contain no `node:` or
 *    `__vite-browser-external` strings.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootRequire = createRequire(join(ROOT, "package.json"));

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
  handleInstallDelivery,
  handleInstallRequest,
  handleWebhookRequest,
  signQueekPayload,
  SqliteInstallationStore,
  verifyQueekSignature,
} from "@usequeek/app-sdk";
import { verifySessionToken } from "@usequeek/app-sdk/server";

const APP_SECRET = "whsec_" + Buffer.from("appsigningsecretAppsecret").toString("base64url"); // fixture, not a credential
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

// Layer 1 directly: untouched bytes + plain headers, no Request, no framework at all.
// Same header id as the delivery above, so the atomic claim must dedupe it.
const direct = await handleInstallDelivery(
  {
    rawBody: Buffer.from(installBody),
    headers: signedHeaders("evt-install-1", NOW, installBody, APP_SECRET),
    method: "POST",
    path: "/install",
  },
  { appSecret: APP_SECRET, store },
);
if (direct.status !== 409) throw new Error("layer-1 replay should dedupe, got: " + direct.status);

// README Express shape: lowercased names, array-valued signature header, Buffer body.
const expressSigned = signedHeaders("evt-install-express", NOW, installBody, APP_SECRET);
const expressHeaders = {
  "webhook-id": expressSigned["webhook-id"],
  "webhook-timestamp": expressSigned["webhook-timestamp"],
  "webhook-signature": [expressSigned["webhook-signature"]],
};
const expressRes = await handleInstallDelivery(
  { rawBody: Buffer.from(installBody), headers: expressHeaders, method: "POST", path: "/api/install" },
  { appSecret: APP_SECRET, store },
);
if (expressRes.status !== 200) throw new Error("layer-1 Express shape failed: " + expressRes.status);

// README Fastify shape: plain IncomingHttpHeaders-like object, Buffer body from parseAs buffer.
const fastifySigned = signedHeaders("evt-install-fastify", NOW, installBody, APP_SECRET);
const fastifyHeaders = {
  "webhook-id": fastifySigned["webhook-id"],
  "webhook-timestamp": fastifySigned["webhook-timestamp"],
  "webhook-signature": fastifySigned["webhook-signature"],
  "content-type": "application/json",
};
const fastifyRes = await handleInstallDelivery(
  { rawBody: Buffer.from(installBody), headers: fastifyHeaders, method: "POST", path: "/api/install" },
  { appSecret: APP_SECRET, store },
);
if (fastifyRes.status !== 200) throw new Error("layer-1 Fastify shape failed: " + fastifyRes.status);

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
// The React subpath MUST NOT load here either: no react is installed, and
// the root entry must not need it.
let reactFailed = false;
try {
  await import("@usequeek/app-sdk/react");
} catch {
  reactFailed = true;
}
if (!reactFailed) throw new Error("@usequeek/app-sdk/react loaded without react installed");
console.log("core ok: install handoff + webhook dispatch with plain Request, layer-1 Express/Fastify shapes, no hono, no react");
`;

/** Sandbox B: WITH `hono` — the thin wrappers serve the same handoff + webhooks. */
const HONO_EXAMPLE = `import { randomBytes } from "node:crypto";
import { SqliteInstallationStore, signQueekPayload } from "@usequeek/app-sdk";
import { createInstallHandlers, createWebhookHandler } from "@usequeek/app-sdk/hono";
import { Hono } from "hono";

const APP_SECRET = "whsec_" + Buffer.from("appsigningsecretAppsecret").toString("base64url"); // fixture, not a credential
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

/** Sandbox C: WITH `react` — the ./react entry resolves and renders once. */
const REACT_EXAMPLE = `import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueekProvider, useQueek } from "@usequeek/app-sdk/react";

if (typeof QueekProvider !== "function") throw new Error("missing QueekProvider");
if (typeof useQueek !== "function") throw new Error("missing useQueek");

function Probe() {
  const queek = useQueek();
  if (typeof queek.toast !== "function") throw new Error("missing toast");
  if (typeof queek.saveBar.dirty !== "function") throw new Error("missing saveBar");
  if (typeof queek.title.set !== "function") throw new Error("missing title");
  if (typeof queek.navigate.report !== "function") throw new Error("missing navigate");
  if (typeof queek.pickResource !== "function") throw new Error("missing pickResource");
  if (queek.theme.mode !== "light") throw new Error("SSR first render must be light, got: " + queek.theme.mode);
  return null;
}
const html = renderToString(
  createElement(
    QueekProvider,
    { dashboardOrigin: "https://merchant.example.com" },
    createElement(Probe),
  ),
);
if (typeof html !== "string") throw new Error("react SSR render failed");
console.log("react ok: ./react resolves QueekProvider + useQueek and renders once via react-dom/server");
`;

function sandbox(pkgName, tarballPath, withHono, exampleSource, extraDeps) {
  const dir = mkdtempSync(join(tmpdir(), withHono ? "sdk-consumer-hono-" : "sdk-consumer-core-"));
  try {
    const dependencies = { [pkgName]: `file:${tarballPath}` };
    if (withHono) dependencies.hono = "^4";
    Object.assign(dependencies, extraDeps ?? {});
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        { name: "sdk-consumer", private: true, version: "1.0.0", type: "module", dependencies },
        null,
        2,
      ),
    );
    const extras = Object.keys(extraDeps ?? {}).join("+");
    console.log(
      `verify-package: installing from the tarball (${withHono ? "with" : "without"} hono${extras ? `, with ${extras}` : ""})…`,
    );
    run("npm", ["install", "--no-audit", "--no-fund"], dir);
    writeFileSync(join(dir, "example.mjs"), exampleSource);
    const out = run("node", ["example.mjs"], dir);
    console.log(out.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Sandbox D: the plain-browser entry — DOM-free load plus a real browser-style bundle. */
const BROWSER_ENTRY = `import {
  LAUNCH_TOKEN_PARAM,
  applyTheme,
  installAuthFetch,
  installThemeListener,
  listenToDashboard,
  readLaunchToken,
  sendNavigated,
  sendOpen,
  sendPickResource,
  sendReady,
  sendSaveBar,
  sendTitle,
  themeBootstrapScript,
} from "@usequeek/app-sdk/browser";

for (const [name, fn] of Object.entries({
  installAuthFetch,
  listenToDashboard,
  sendReady,
  sendNavigated,
  sendOpen,
  sendTitle,
  sendSaveBar,
  sendPickResource,
  applyTheme,
  installThemeListener,
  themeBootstrapScript,
  readLaunchToken,
})) {
  if (typeof fn !== "function") throw new Error("missing browser export: " + name);
}
if (LAUNCH_TOKEN_PARAM !== "queek_token") throw new Error("LAUNCH_TOKEN_PARAM moved");
if (readLaunchToken("https://app.example/?queek_token=abc") !== "abc") {
  throw new Error("readLaunchToken broken");
}
if (!themeBootstrapScript().includes("sessionStorage")) throw new Error("themeBootstrapScript broken");
console.log("browser entry ok: installAuthFetch + bridge/theme helpers load with no DOM");
`;

function sandboxBrowser(pkgName, tarballPath) {
  const dir = mkdtempSync(join(tmpdir(), "sdk-consumer-browser-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "sdk-consumer-browser",
          private: true,
          version: "1.0.0",
          type: "module",
          dependencies: { [pkgName]: `file:${tarballPath}` },
        },
        null,
        2,
      ),
    );
    console.log("verify-package: installing from the tarball (browser bundle, no node polyfills)…");
    run("npm", ["install", "--no-audit", "--no-fund"], dir);
    writeFileSync(join(dir, "entry.js"), BROWSER_ENTRY);
    // The subpath must load in a DOM-free runtime first (browser entry, no browser).
    console.log(run("node", ["entry.js"], dir).trim());
    // Then it must bundle the way a browser app bundler does: a node-only
    // import anywhere in the graph fails this build (esbuild ships no node
    // polyfills), which is exactly how a Vite/Rollup browser build fails.
    let esbuild;
    try {
      esbuild = rootRequire("esbuild");
    } catch {
      throw new Error("esbuild is required for the browser bundle check (devDependency via vitest)");
    }
    esbuild.buildSync({
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      platform: "browser",
      format: "iife",
      outfile: join(dir, "bundle.js"),
      logLevel: "error",
    });
    const bundle = readFileSync(join(dir, "bundle.js"), "utf-8");
    if (!bundle.includes("queek_token")) {
      throw new Error("browser bundle looks tree-shaken empty (no queek_token)");
    }
    for (const banned of ["node:", "__vite-browser-external"]) {
      if (bundle.includes(banned)) {
        throw new Error(`browser bundle leaks ${banned}`);
      }
    }
    console.log(
      "browser ok: esbuild platform=browser bundles ./browser with no node: or __vite-browser-external",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const { pkg, tarballPath } = pack();
  try {
    sandbox(pkg.name, tarballPath, false, CORE_EXAMPLE);
    sandbox(pkg.name, tarballPath, true, HONO_EXAMPLE);
    sandbox(pkg.name, tarballPath, false, REACT_EXAMPLE, { react: "^19", "react-dom": "^19" });
    sandboxBrowser(pkg.name, tarballPath);
    console.log(
      "verify-package: outsider consumer passed (core without hono/react, wrappers with hono, react entry with react, browser entry bundles clean)",
    );
  } finally {
    rmSync(join(tarballPath, ".."), { recursive: true, force: true });
  }
}

main();
