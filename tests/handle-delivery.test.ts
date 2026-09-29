import { describe, expect, it, vi } from "vitest";
import type { CoreHeaders } from "../src/delivery.js";
import { createInstallHandlers, createWebhookHandler } from "../src/hono.js";
import { handleInstallDelivery, handleInstallRequest } from "../src/install-handlers.js";
import { SqliteInstallationStore } from "../src/store.js";
import { handleWebhookDelivery, handleWebhookRequest, type WebhookHandlerFn } from "../src/webhooks.js";
import { installBody, signedHeaders } from "./helpers.js";

const APP_SECRET = "whsec_YXBwc2lnbmluZ3NlY3JldGFwcHNlY3JldA==";
const STORE_KEY = Buffer.alloc(32, 7).toString("base64");
const NOW = 1758685600;

const WEBHOOK_SECRET = "whsec_ZW5kcG9pbnRzZWNyZXRlbmRwb2ludHNlY3I=";
const INSTALLATION_ID = "11111111-1111-1111-1111-111111111111";

function newStore() {
  return new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
}

function installOpts(store: SqliteInstallationStore) {
  return { appSecret: APP_SECRET, store, nowSeconds: NOW };
}

function deliveryBody(eventId: string): string {
  return JSON.stringify({
    id: eventId,
    topic: "orders/updated",
    api_version: "v1",
    created_at: "2026-09-24T00:00:00+00:00",
    data: { order: { id: "order-1" } },
  });
}

async function seedWebhookInstallation(store: SqliteInstallationStore) {
  const now = new Date().toISOString();
  await store.saveInstallation({
    installationId: INSTALLATION_ID,
    installationPid: "inst_abc123",
    vendorId: "22222222-2222-2222-2222-222222222222",
    storePid: "store_xyz",
    storeName: "Test Store",
    apiBase: "https://api.usequeek.com/api/v1/merchant",
    token: null,
    tokenExpiresAt: null,
    tokenKid: null,
    pending: false,
    scopes: ["merchant-orders-read"],
    settings: {},
    webhookSecret: WEBHOOK_SECRET,
    proxySecret: null,
    embedSecret: null,
    appId: null,
    webhookUrl: "https://hello.apps.usequeek.com/webhooks",
    webhookTopics: ["orders/updated"],
    installedAt: now,
    updatedAt: now,
  });
}

describe("layer 1: handleInstallDelivery with plain inputs", () => {
  it("serves a valid handoff from Buffer bytes + a plain header object", async () => {
    const store = newStore();
    const body = installBody();
    const headers = signedHeaders("evt-install-1", NOW, body, APP_SECRET);
    const result = await handleInstallDelivery(
      { rawBody: Buffer.from(body, "utf8"), headers, method: "POST", path: "/install" },
      installOpts(store),
    );
    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect((await store.getInstallation(INSTALLATION_ID))?.storePid).toBe("store_xyz");
  });

  it("accepts Uint8Array bytes, string bodies, and mixed-case header names", async () => {
    const store = newStore();
    const body = installBody();
    const signed = signedHeaders("evt-install-1", NOW, body, APP_SECRET);
    const mixedCase: CoreHeaders = {
      "Webhook-Id": signed["webhook-id"],
      "WEBHOOK-TIMESTAMP": signed["webhook-timestamp"],
      "Webhook-Signature": signed["webhook-signature"],
    };
    const fromBytes = await handleInstallDelivery(
      { rawBody: new TextEncoder().encode(body), headers: mixedCase, path: "/install" },
      installOpts(store),
    );
    expect(fromBytes.status).toBe(200);

    const store2 = newStore();
    const fromString = await handleInstallDelivery(
      { rawBody: body, headers: new Headers(signed as Record<string, string>), path: "/install" },
      installOpts(store2),
    );
    expect(fromString).toEqual({ status: 200, body: { ok: true } });
  });

  it("accepts Express-style lowercased headers with array values", async () => {
    const store = newStore();
    const body = installBody();
    const signed = signedHeaders("evt-express-1", NOW, body, APP_SECRET);
    // Express lowercases incoming header names and may hold array values.
    const expressStyle: CoreHeaders = {
      "webhook-id": signed["webhook-id"],
      "webhook-timestamp": signed["webhook-timestamp"],
      "webhook-signature": [signed["webhook-signature"]],
    };
    const result = await handleInstallDelivery(
      { rawBody: Buffer.from(body), headers: expressStyle, method: "POST", path: "/install" },
      installOpts(store),
    );
    expect(result).toEqual({ status: 200, body: { ok: true } });
  });

  it("answers 405 for non-POST and 404 for an unknown path", async () => {
    const store = newStore();
    const body = installBody();
    const headers = signedHeaders("evt-install-1", NOW, body, APP_SECRET);
    expect(
      await handleInstallDelivery({ rawBody: body, headers, method: "GET", path: "/install" }, installOpts(store)),
    ).toEqual({ status: 405, body: { ok: false, error: "method_not_allowed" } });
    expect(
      await handleInstallDelivery({ rawBody: body, headers, path: "/billing" }, installOpts(store)),
    ).toEqual({ status: 404, body: { ok: false, error: "unknown_route" } });
  });
});

describe("layer 1: handleWebhookDelivery with plain inputs", () => {
  it("dispatches from Buffer bytes + a plain header object", async () => {
    const store = newStore();
    await seedWebhookInstallation(store);
    const onOrder = vi.fn(async () => {});
    const body = deliveryBody("evt-1");
    const result = await handleWebhookDelivery(
      {
        rawBody: Buffer.from(body, "utf8"),
        headers: {
          ...signedHeaders("evt-1", NOW, body, WEBHOOK_SECRET),
          "X-Queek-Topic": "orders/updated",
        },
      },
      { store, nowSeconds: NOW, handlers: { "orders/updated": onOrder as WebhookHandlerFn } },
    );
    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(onOrder).toHaveBeenCalledTimes(1);
  });
});

describe("raw-body rule: parsed-then-restringified JSON must FAIL verification", () => {
  it("rejects a re-serialized body with the original signature at every layer", async () => {
    const body = installBody();
    // Same JSON value, different bytes (indentation) — the signature covers bytes, not values.
    const reserialized = JSON.stringify(JSON.parse(body), null, 2);
    expect(reserialized).not.toBe(body);
    const headers = signedHeaders("evt-install-1", NOW, body, APP_SECRET);

    const layer1 = await handleInstallDelivery(
      { rawBody: reserialized, headers, path: "/install" },
      installOpts(newStore()),
    );
    expect(layer1).toEqual({ status: 401, body: { ok: false, error: "signature mismatch" } });

    const layer2 = await handleInstallRequest(
      new Request("http://localhost/install", { method: "POST", headers, body: reserialized }),
      installOpts(newStore()),
    );
    expect(layer2.status).toBe(401);
    expect(await layer2.json()).toEqual({ ok: false, error: "signature mismatch" });

    const app = createInstallHandlers(installOpts(newStore()));
    const layer3 = await app.request("/install", { method: "POST", headers, body: reserialized });
    expect(layer3.status).toBe(401);
    expect(await layer3.json()).toEqual({ ok: false, error: "signature mismatch" });
  });
});

describe("cross-layer parity: identical results for the same inputs", () => {
  async function expectIdentical(
    kind: "install" | "webhook",
    path: string,
    body: string,
    headers: Record<string, string>,
  ) {
    const installSetup = (store: SqliteInstallationStore) => installOpts(store);
    const noop = (async () => {}) as WebhookHandlerFn;
    const webhookSetup = (store: SqliteInstallationStore) => ({
      store,
      nowSeconds: NOW,
      handlers: { "orders/updated": noop },
    });

    // Layer 1: Buffer bytes + plain object headers.
    const store1 = newStore();
    if (kind === "webhook") await seedWebhookInstallation(store1);
    const one =
      kind === "install"
        ? await handleInstallDelivery(
            { rawBody: Buffer.from(body), headers, method: "POST", path },
            installSetup(store1),
          )
        : await handleWebhookDelivery({ rawBody: Buffer.from(body), headers }, webhookSetup(store1));

    // Layer 2: plain `new Request(...)`.
    const store2 = newStore();
    if (kind === "webhook") await seedWebhookInstallation(store2);
    const twoResponse =
      kind === "install"
        ? await handleInstallRequest(
            new Request(`http://localhost${path}`, { method: "POST", headers, body }),
            installSetup(store2),
          )
        : await handleWebhookRequest(
            new Request(`http://localhost${path}`, { method: "POST", headers, body }),
            webhookSetup(store2),
          );
    const two = { status: twoResponse.status, body: await twoResponse.json() };

    // Layer 3: the Hono wrappers.
    const store3 = newStore();
    if (kind === "webhook") await seedWebhookInstallation(store3);
    const app =
      kind === "install"
        ? createInstallHandlers(installSetup(store3))
        : createWebhookHandler(webhookSetup(store3));
    const threeResponse = await app.request(kind === "install" ? path : "/", {
      method: "POST",
      headers,
      body,
    });
    const three = { status: threeResponse.status, body: await threeResponse.json() };

    expect(two).toEqual({ status: one.status, body: one.body });
    expect(three).toEqual({ status: one.status, body: one.body });
  }

  it("install: valid, bad signature, wrong event type, resync", async () => {
    const body = installBody();
    await expectIdentical("install", "/install", body, signedHeaders("evt-p1", NOW, body, APP_SECRET));
    await expectIdentical(
      "install",
      "/install",
      body,
      signedHeaders("evt-p2", NOW, body, "whsec_d3JvbmdzZWNyZXR3cm9uZ3NlY3JldHhy"),
    );
    const wrongType = JSON.stringify({
      id: "evt-x",
      type: "app/uninstalled",
      api_version: "v1",
      created_at: "x",
      data: {},
    });
    await expectIdentical("install", "/install", wrongType, signedHeaders("evt-x", NOW, wrongType, APP_SECRET));
    const resync = JSON.stringify({
      id: "evt-r",
      type: "app/resync",
      api_version: "v1",
      created_at: "2026-09-25T00:00:00+00:00",
      data: {
        installation: { id: INSTALLATION_ID, p_id: "inst_abc123" },
        app_id: "app-uuid-hello",
        store: {
          id: "22222222-2222-2222-2222-222222222222",
          p_id: "store_xyz",
          name: "Test Store",
          is_test: true,
        },
        api_base: "https://api.usequeek.com/api/v1/merchant",
        scopes: ["merchant-business_profile-read"],
        settings: { greeting: "resynced" },
        webhook_secret: "whsec_resync_secret",
        webhook_url: "https://hello.apps.usequeek.com/webhooks",
        webhook_topics: ["orders/updated"],
      },
    });
    await expectIdentical("install", "/settings", resync, signedHeaders("evt-r", NOW, resync, APP_SECRET));
  });

  it("uninstall + settings-404", async () => {
    const uninstall = JSON.stringify({
      id: "evt-u",
      type: "app/uninstalled",
      api_version: "v1",
      created_at: "2026-09-24T00:00:00+00:00",
      data: {
        installation: { id: INSTALLATION_ID, p_id: "inst_abc123" },
        store: { id: "22222222-2222-2222-2222-222222222222", p_id: "store_xyz", name: "Test", is_test: true },
      },
    });
    await expectIdentical("install", "/uninstall", uninstall, signedHeaders("evt-u", NOW, uninstall, APP_SECRET));
    const missing = JSON.stringify({
      id: "evt-s0",
      type: "app/settings_updated",
      api_version: "v1",
      created_at: "2026-09-24T00:00:00+00:00",
      data: {
        installation: { id: "99999999-9999-9999-9999-999999999999", p_id: "nope" },
        store: null,
        settings: { color: "red" },
      },
    });
    await expectIdentical("install", "/settings", missing, signedHeaders("evt-s0", NOW, missing, APP_SECRET));
  });

  it("webhooks: dispatch, dedupe, unhandled topic, unknown installation", async () => {
    const body = deliveryBody("evt-w1");
    const headers = {
      ...signedHeaders("evt-w1", NOW, body, WEBHOOK_SECRET),
      "X-Queek-Topic": "orders/updated",
    };
    await expectIdentical("webhook", "/webhooks", body, headers);

    const unhandled = JSON.stringify({
      id: "evt-w2",
      topic: "products/create",
      api_version: "v1",
      created_at: "2026-09-24T00:00:00+00:00",
      data: {},
    });
    await expectIdentical(
      "webhook",
      "/webhooks",
      unhandled,
      signedHeaders("evt-w2", NOW, unhandled, WEBHOOK_SECRET),
    );

    // Unknown installation: replay the same delivery against empty stores.
    const stores = [newStore(), newStore(), newStore()];
    const unknown = deliveryBody("evt-w9");
    const unknownHeaders = signedHeaders("evt-w9", NOW, unknown, WEBHOOK_SECRET);
    const one = await handleWebhookDelivery(
      { rawBody: Buffer.from(unknown), headers: unknownHeaders },
      { store: stores[0], nowSeconds: NOW, handlers: {} },
    );
    const twoRes = await handleWebhookRequest(
      new Request("http://localhost/webhooks", { method: "POST", headers: unknownHeaders, body: unknown }),
      { store: stores[1], nowSeconds: NOW, handlers: {} },
    );
    const app = createWebhookHandler({ store: stores[2], nowSeconds: NOW, handlers: {} });
    const threeRes = await app.request("/", { method: "POST", headers: unknownHeaders, body: unknown });
    expect(one.status).toBe(401);
    expect(twoRes.status).toBe(401);
    expect(threeRes.status).toBe(401);
    expect(await twoRes.json()).toEqual(one.body);
    expect(await threeRes.json()).toEqual(one.body);
  });
});
