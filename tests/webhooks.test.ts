import { beforeEach, describe, expect, it, vi } from "vitest";
import { type InstallationRecord, SqliteInstallationStore } from "../src/store.js";
import { createWebhookHandler, type WebhookHandlerFn } from "../src/webhooks.js";
import { postRaw, signedHeaders } from "./helpers.js";

const STORE_KEY = Buffer.alloc(32, 9).toString("base64");
const NOW = 1758685600;
const INSTALLATION_ID = "11111111-1111-1111-1111-111111111111";
const WEBHOOK_SECRET = "whsec_ZW5kcG9pbnRzZWNyZXRlbmRwb2ludHNlY3I=";

function record(): InstallationRecord {
  return {
    installationId: INSTALLATION_ID,
    installationPid: "inst_abc123",
    vendorId: "22222222-2222-2222-2222-222222222222",
    storePid: "store_xyz",
    storeName: "Test Store",
    apiBase: "https://api.usequeek.com/api/v1/merchant",
    token: "tok_test_cached",
    tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    tokenKid: "kid-1",
    pending: false,
    scopes: ["merchant-orders-read"],
    settings: {},
    webhookSecret: WEBHOOK_SECRET,
    webhookUrl: "https://hello.apps.usequeek.com/webhooks",
    webhookTopics: ["orders/updated"],
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
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

describe("webhook handler", () => {
  let store: SqliteInstallationStore;
  beforeEach(() => {
    store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    store.saveInstallation(record());
  });

  function setup(extra: Record<string, WebhookHandlerFn> = {}) {
    const onOrder = vi.fn(async () => {});
    const app = createWebhookHandler({
      store,
      nowSeconds: NOW,
      handlers: { "orders/updated": onOrder as WebhookHandlerFn, ...extra },
    });
    return { app, onOrder };
  }

  it("dispatches by topic with the resolved installation", async () => {
    const { app, onOrder } = setup();
    const body = deliveryBody("evt-1");
    const response = await postRaw(app, "/", body, {
      ...signedHeaders("evt-1", NOW, body, WEBHOOK_SECRET),
      "X-Queek-Topic": "orders/updated",
    });

    expect(response.status).toBe(200);
    expect(onOrder).toHaveBeenCalledTimes(1);
    const [, context] = onOrder.mock.calls[0] as unknown as [unknown, { installation: InstallationRecord }];
    expect(context.installation.installationId).toBe(INSTALLATION_ID);
    expect(context.installation.token).toBe("tok_test_cached");
  });

  it("dedupes by webhook-id: the repeat answers 200 without re-running the handler", async () => {
    const { app, onOrder } = setup();
    const body = deliveryBody("evt-1");
    const headers = {
      ...signedHeaders("evt-1", NOW, body, WEBHOOK_SECRET),
      "X-Queek-Topic": "orders/updated",
    };
    expect((await postRaw(app, "/", body, headers)).status).toBe(200);
    const repeat = await postRaw(app, "/", body, headers);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ ok: true, deduped: true });
    expect(onOrder).toHaveBeenCalledTimes(1);
  });

  it("answers 401 when no stored secret verifies (unknown installation)", async () => {
    const empty = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    const app = createWebhookHandler({ store: empty, nowSeconds: NOW, handlers: {} });
    const body = deliveryBody("evt-1");
    const response = await postRaw(app, "/", body, signedHeaders("evt-1", NOW, body, WEBHOOK_SECRET));
    expect(response.status).toBe(401);
  });

  it("answers 401 on a stale timestamp even with the right secret", async () => {
    const { app, onOrder } = setup();
    const body = deliveryBody("evt-1");
    const response = await postRaw(app, "/", body, signedHeaders("evt-1", NOW - 3600, body, WEBHOOK_SECRET));
    expect(response.status).toBe(401);
    expect(onOrder).not.toHaveBeenCalled();
  });

  it("answers 200 (not a retry loop) for a topic with no handler", async () => {
    const { app, onOrder } = setup();
    const body = JSON.stringify({
      id: "evt-2",
      topic: "products/create",
      api_version: "v1",
      created_at: "2026-09-24T00:00:00+00:00",
      data: {},
    });
    const response = await postRaw(app, "/", body, signedHeaders("evt-2", NOW, body, WEBHOOK_SECRET));
    expect(response.status).toBe(200);
    expect(onOrder).not.toHaveBeenCalled();
  });

  it("runs concurrent same-id deliveries exactly once (atomic claim)", async () => {
    const slow = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const app = createWebhookHandler({
      store,
      nowSeconds: NOW,
      handlers: { "orders/updated": slow as WebhookHandlerFn },
    });
    const body = deliveryBody("evt-race");
    const headers = () => ({ ...signedHeaders("evt-race", NOW, body, WEBHOOK_SECRET) });
    const results = await Promise.all(Array.from({ length: 8 }, () => postRaw(app, "/", body, headers())));
    const payloads = await Promise.all(results.map((r) => r.json()));
    expect(slow).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(payloads.filter((p) => (p as { deduped?: boolean }).deduped === true)).toHaveLength(7);
  });

  it("answers 500 when the handler throws, so Queek retries", async () => {
    const app = createWebhookHandler({
      store,
      nowSeconds: NOW,
      handlers: {
        "orders/updated": async () => {
          throw new Error("boom");
        },
      },
    });
    const body = deliveryBody("evt-1");
    const response = await postRaw(app, "/", body, signedHeaders("evt-1", NOW, body, WEBHOOK_SECRET));
    expect(response.status).toBe(500);
    expect(await store.hasSeenWebhookId("evt-1")).toBe(false);
  });
});
