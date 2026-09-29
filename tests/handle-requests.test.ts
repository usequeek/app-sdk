import { describe, expect, it, vi } from "vitest";
import { createInstallHandlers, createWebhookHandler } from "../src/hono.js";
import { handleInstallRequest, type InstallHandlerOptions } from "../src/install-handlers.js";
import { SqliteInstallationStore } from "../src/store.js";
import { handleWebhookRequest, type WebhookHandlerFn } from "../src/webhooks.js";
import { installBody, resyncBody, signedHeaders } from "./helpers.js";

const APP_SECRET = "whsec_YXBwc2lnbmluZ3NlY3JldGFwcHNlY3JldA==";
const STORE_KEY = Buffer.alloc(32, 7).toString("base64");
const NOW = 1758685600;

const WEBHOOK_SECRET = "whsec_ZW5kcG9pbnRzZWNyZXRlbmRwb2ludHNlY3I=";
const INSTALLATION_ID = "11111111-1111-1111-1111-111111111111";

function installOptions(
  store: SqliteInstallationStore,
  overrides: Partial<InstallHandlerOptions> = {},
): InstallHandlerOptions {
  return { appSecret: APP_SECRET, store, nowSeconds: NOW, ...overrides };
}

function webRequest(path: string, body: string, headers: Record<string, string>, method = "POST") {
  if (method === "GET" || method === "HEAD") {
    return new Request(`http://localhost${path}`, { method, headers });
  }
  return new Request(`http://localhost${path}`, { method, headers, body });
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

describe("handleInstallRequest (framework-agnostic core)", () => {
  it("answers 200 and stores the installation on a valid handoff", async () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    const body = installBody();
    const response = await handleInstallRequest(
      webRequest("/install", body, signedHeaders("evt-install-1", NOW, body, APP_SECRET)),
      installOptions(store),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const stored = await store.getInstallation(INSTALLATION_ID);
    expect(stored?.storePid).toBe("store_xyz");
    expect(stored?.webhookSecret).toContain("whsec_");
  });

  it("answers 401 on a bad signature and stores nothing", async () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    const body = installBody();
    const response = await handleInstallRequest(
      webRequest(
        "/install",
        body,
        signedHeaders("evt-install-1", NOW, body, "whsec_d3JvbmdzZWNyZXR3cm9uZ3NlY3JldHhy"),
      ),
      installOptions(store),
    );
    expect(response.status).toBe(401);
    expect(await store.getInstallation(INSTALLATION_ID)).toBeNull();
  });

  it("answers 409 on a replayed delivery id and 401 on a stale timestamp", async () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    const options = installOptions(store);
    const body = installBody();
    const headers = signedHeaders("evt-install-1", NOW, body, APP_SECRET);
    expect((await handleInstallRequest(webRequest("/install", body, headers), options)).status).toBe(200);
    expect((await handleInstallRequest(webRequest("/install", body, headers), options)).status).toBe(409);
    const stale = installBody();
    expect(
      (
        await handleInstallRequest(
          webRequest("/install", stale, signedHeaders("evt-stale", NOW - 3600, stale, APP_SECRET)),
          options,
        )
      ).status,
    ).toBe(401);
  });

  it("answers 500 when the store write fails — and releases the claim so a retry can land", async () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    const options = installOptions(store, {
      onInstall: async () => {
        throw new Error("disk on fire");
      },
    });
    const body = installBody();
    const response = await handleInstallRequest(
      webRequest("/install", body, signedHeaders("evt-install-1", NOW, body, APP_SECRET)),
      options,
    );
    expect(response.status).toBe(500);
    expect(await store.hasSeenWebhookId("evt-install-1")).toBe(false);
  });

  it("answers 400 when the event type does not belong on the route", async () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    const body = JSON.stringify({
      id: "evt-x",
      type: "app/uninstalled",
      api_version: "v1",
      created_at: "x",
      data: {},
    });
    const response = await handleInstallRequest(
      webRequest("/install", body, signedHeaders("evt-x", NOW, body, APP_SECRET)),
      installOptions(store),
    );
    expect(response.status).toBe(400);
  });

  it("uninstall deletes the installation; settings merges, 404s on unknown installations", async () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    const options = installOptions(store);
    const install = installBody();
    await handleInstallRequest(
      webRequest("/install", install, signedHeaders("evt-install-1", NOW, install, APP_SECRET)),
      options,
    );

    const settings = JSON.stringify({
      id: "evt-settings-1",
      type: "app/settings_updated",
      api_version: "v1",
      created_at: "2026-09-24T00:00:00+00:00",
      data: {
        installation: { id: INSTALLATION_ID, p_id: "inst_abc123" },
        store: null,
        settings: { color: "red" },
      },
    });
    expect(
      (
        await handleInstallRequest(
          webRequest("/settings", settings, signedHeaders("evt-settings-1", NOW, settings, APP_SECRET)),
          options,
        )
      ).status,
    ).toBe(200);
    expect((await store.getInstallation(INSTALLATION_ID))?.settings).toEqual({ color: "red" });

    const missing = JSON.stringify({
      id: "evt-settings-0",
      type: "app/settings_updated",
      api_version: "v1",
      created_at: "2026-09-24T00:00:00+00:00",
      data: {
        installation: { id: "99999999-9999-9999-9999-999999999999", p_id: "nope" },
        store: null,
        settings: { color: "red" },
      },
    });
    expect(
      (
        await handleInstallRequest(
          webRequest("/settings", missing, signedHeaders("evt-settings-0", NOW, missing, APP_SECRET)),
          options,
        )
      ).status,
    ).toBe(404);

    const uninstall = JSON.stringify({
      id: "evt-uninstall-1",
      type: "app/uninstalled",
      api_version: "v1",
      created_at: "2026-09-24T00:00:00+00:00",
      data: {
        installation: { id: INSTALLATION_ID, p_id: "inst_abc123" },
        store: { id: "22222222-2222-2222-2222-222222222222", p_id: "store_xyz", name: "Test", is_test: true },
      },
    });
    expect(
      (
        await handleInstallRequest(
          webRequest("/uninstall", uninstall, signedHeaders("evt-uninstall-1", NOW, uninstall, APP_SECRET)),
          options,
        )
      ).status,
    ).toBe(200);
    expect(await store.getInstallation(INSTALLATION_ID)).toBeNull();
  });

  it("accepts the platform resync on both /install and /settings", async () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    const options = installOptions(store);
    const install = installBody();
    await handleInstallRequest(
      webRequest("/install", install, signedHeaders("evt-install-1", NOW, install, APP_SECRET)),
      options,
    );
    const before = await store.getInstallation(INSTALLATION_ID);

    const viaInstall = resyncBody({ webhook_secret: "whsec_rotated_via_install" });
    expect(
      (
        await handleInstallRequest(
          webRequest("/install", viaInstall, signedHeaders("evt-resync-1", NOW, viaInstall, APP_SECRET)),
          options,
        )
      ).status,
    ).toBe(200);
    expect((await store.getInstallation(INSTALLATION_ID))?.webhookSecret).toBe("whsec_rotated_via_install");
    expect((await store.getInstallation(INSTALLATION_ID))?.installedAt).toBe(before?.installedAt);

    const viaSettings = resyncBody({ webhook_secret: "whsec_rotated_via_settings" });
    expect(
      (
        await handleInstallRequest(
          webRequest("/settings", viaSettings, signedHeaders("evt-resync-9", NOW, viaSettings, APP_SECRET)),
          options,
        )
      ).status,
    ).toBe(200);
    expect((await store.getInstallation(INSTALLATION_ID))?.webhookSecret).toBe("whsec_rotated_via_settings");
  });

  it("answers 405 for non-POST and 404 for an unknown trailing segment", async () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    const options = installOptions(store);
    const body = installBody();
    expect(
      (
        await handleInstallRequest(
          webRequest("/install", body, signedHeaders("evt-install-1", NOW, body, APP_SECRET), "GET"),
          options,
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await handleInstallRequest(
          webRequest("/billing", body, signedHeaders("evt-install-1", NOW, body, APP_SECRET)),
          options,
        )
      ).status,
    ).toBe(404);
  });
});

describe("handleWebhookRequest (framework-agnostic core)", () => {
  it("dispatches by topic, dedupes repeats, and rejects unknown secrets", async () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    await seedWebhookInstallation(store);
    const onOrder = vi.fn(async () => {});
    const options = { store, nowSeconds: NOW, handlers: { "orders/updated": onOrder as WebhookHandlerFn } };

    const body = deliveryBody("evt-1");
    const headers = {
      ...signedHeaders("evt-1", NOW, body, WEBHOOK_SECRET),
      "X-Queek-Topic": "orders/updated",
    };
    const first = await handleWebhookRequest(webRequest("/webhooks", body, headers), options);
    expect(first.status).toBe(200);
    expect(onOrder).toHaveBeenCalledTimes(1);

    const repeat = await handleWebhookRequest(webRequest("/webhooks", body, headers), options);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ ok: true, deduped: true });
    expect(onOrder).toHaveBeenCalledTimes(1);

    const stale = deliveryBody("evt-stale");
    expect(
      (
        await handleWebhookRequest(
          webRequest("/webhooks", stale, signedHeaders("evt-stale", NOW - 3600, stale, WEBHOOK_SECRET)),
          options,
        )
      ).status,
    ).toBe(401);

    const empty = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    const unknown = deliveryBody("evt-unknown");
    expect(
      (
        await handleWebhookRequest(
          webRequest("/webhooks", unknown, signedHeaders("evt-unknown", NOW, unknown, WEBHOOK_SECRET)),
          { store: empty, nowSeconds: NOW, handlers: {} },
        )
      ).status,
    ).toBe(401);
  });

  it("answers 200 for an unhandled topic and 500 when the handler throws (claim released)", async () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    await seedWebhookInstallation(store);
    const unhandled = JSON.stringify({
      id: "evt-2",
      topic: "products/create",
      api_version: "v1",
      created_at: "2026-09-24T00:00:00+00:00",
      data: {},
    });
    const idle = await handleWebhookRequest(
      webRequest("/webhooks", unhandled, signedHeaders("evt-2", NOW, unhandled, WEBHOOK_SECRET)),
      { store, nowSeconds: NOW, handlers: {} },
    );
    expect(idle.status).toBe(200);
    expect(await idle.json()).toEqual({ ok: true, unhandled: true });

    const failing = deliveryBody("evt-3");
    const failed = await handleWebhookRequest(
      webRequest("/webhooks", failing, signedHeaders("evt-3", NOW, failing, WEBHOOK_SECRET)),
      {
        store,
        nowSeconds: NOW,
        handlers: {
          "orders/updated": async () => {
            throw new Error("boom");
          },
        },
      },
    );
    expect(failed.status).toBe(500);
    expect(await store.hasSeenWebhookId("evt-3")).toBe(false);
  });
});

describe("core ↔ hono parity", () => {
  async function expectParity(
    path: string,
    body: string,
    headers: Record<string, string>,
    setup: (store: SqliteInstallationStore) => {
      install?: InstallHandlerOptions;
      webhook?: { store: SqliteInstallationStore; handlers: Record<string, WebhookHandlerFn> };
    },
  ) {
    const coreStore = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    const honoStore = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    const coreSetup = setup(coreStore);
    const honoSetup = setup(honoStore);

    let coreRes: Response;
    let honoRes: Response;
    if (coreSetup.install && honoSetup.install) {
      coreRes = await handleInstallRequest(webRequest(path, body, headers), coreSetup.install);
      const app = createInstallHandlers(honoSetup.install);
      honoRes = await app.request(path, { method: "POST", headers, body });
    } else if (coreSetup.webhook && honoSetup.webhook) {
      coreRes = await handleWebhookRequest(webRequest(path, body, headers), {
        ...coreSetup.webhook,
        nowSeconds: NOW,
      });
      const app = createWebhookHandler({ ...honoSetup.webhook, nowSeconds: NOW });
      honoRes = await app.request(path === "/webhooks" ? "/" : path, { method: "POST", headers, body });
    } else {
      throw new Error("parity case needs install or webhook options");
    }
    expect(honoRes.status).toBe(coreRes.status);
    expect(await honoRes.json()).toEqual(await coreRes.json());
  }

  const installSetup = (store: SqliteInstallationStore) => ({
    install: installOptions(store),
  });

  it("install: valid handoff, bad signature, replay, wrong type", async () => {
    const body = installBody();
    await expectParity("/install", body, signedHeaders("evt-p1", NOW, body, APP_SECRET), installSetup);
    await expectParity(
      "/install",
      body,
      signedHeaders("evt-p2", NOW, body, "whsec_d3JvbmdzZWNyZXR3cm9uZ3NlY3JldHhy"),
      installSetup,
    );
    const wrongType = JSON.stringify({
      id: "evt-x",
      type: "app/uninstalled",
      api_version: "v1",
      created_at: "x",
      data: {},
    });
    await expectParity(
      "/install",
      wrongType,
      signedHeaders("evt-x", NOW, wrongType, APP_SECRET),
      installSetup,
    );

    // Replay: same header id twice — both sides must answer 200 then 409.
    const replay = installBody();
    const headers = signedHeaders("evt-replay", NOW, replay, APP_SECRET);
    const coreStore = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    const honoStore = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    const coreOpts = installOptions(coreStore);
    const honoApp = createInstallHandlers(installOptions(honoStore));
    for (const expected of [200, 409]) {
      const coreRes = await handleInstallRequest(webRequest("/install", replay, headers), coreOpts);
      const honoRes = await honoApp.request("/install", { method: "POST", headers, body: replay });
      expect(coreRes.status).toBe(expected);
      expect(honoRes.status).toBe(expected);
      expect(await honoRes.json()).toEqual(await coreRes.json());
    }
  });

  it("uninstall + settings + resync", async () => {
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
    await expectParity(
      "/uninstall",
      uninstall,
      signedHeaders("evt-u", NOW, uninstall, APP_SECRET),
      installSetup,
    );
    const resync = resyncBody();
    await expectParity("/install", resync, signedHeaders("evt-r", NOW, resync, APP_SECRET), installSetup);
    await expectParity("/settings", resync, signedHeaders("evt-r2", NOW, resync, APP_SECRET), installSetup);
  });

  it("webhooks: dispatch, dedupe, unhandled topic", async () => {
    const noop = (async () => {}) as WebhookHandlerFn;
    const coreStore = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    const honoStore = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    await seedWebhookInstallation(coreStore);
    await seedWebhookInstallation(honoStore);
    const honoApp = createWebhookHandler({
      store: honoStore,
      nowSeconds: NOW,
      handlers: { "orders/updated": noop },
    });
    const coreOpts = { store: coreStore, nowSeconds: NOW, handlers: { "orders/updated": noop } };

    // Dispatch, then the same delivery id (deduped), then an unhandled topic.
    const body = deliveryBody("evt-w1");
    const headers = {
      ...signedHeaders("evt-w1", NOW, body, WEBHOOK_SECRET),
      "X-Queek-Topic": "orders/updated",
    };
    const unhandledBody = JSON.stringify({
      id: "evt-w2",
      topic: "products/create",
      api_version: "v1",
      created_at: "2026-09-24T00:00:00+00:00",
      data: {},
    });
    const unhandledHeaders = signedHeaders("evt-w2", NOW, unhandledBody, WEBHOOK_SECRET);
    for (const [path, payload, hdrs] of [
      ["/webhooks", body, headers],
      ["/webhooks", body, headers],
      ["/webhooks", unhandledBody, unhandledHeaders],
    ] as const) {
      const coreRes = await handleWebhookRequest(webRequest(path, payload, hdrs), coreOpts);
      const honoRes = await honoApp.request("/", { method: "POST", headers: hdrs, body: payload });
      expect(honoRes.status).toBe(coreRes.status);
      expect(await honoRes.json()).toEqual(await coreRes.json());
    }
  });
});
