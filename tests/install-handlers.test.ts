import { beforeEach, describe, expect, it } from "vitest";
import { createInstallHandlers } from "../src/install-handlers.js";
import { SqliteInstallationStore } from "../src/store.js";
import { installBody, postRaw, signedHeaders } from "./helpers.js";

const APP_SECRET = "whsec_YXBwc2lnbmluZ3NlY3JldGFwcHNlY3JldA==";
const STORE_KEY = Buffer.alloc(32, 7).toString("base64");
const NOW = 1758685600;

function setup(overrides: Parameters<typeof createInstallHandlers>[0] = {}) {
  const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
  const app = createInstallHandlers({ appSecret: APP_SECRET, store, nowSeconds: NOW, ...overrides });
  return { store, app };
}

describe("install handler", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("answers 200 and stores the installation on a valid handoff", async () => {
    const body = installBody();
    const response = await postRaw(
      ctx.app,
      "/install",
      body,
      signedHeaders("evt-install-1", NOW, body, APP_SECRET),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const stored = await ctx.store.getInstallation("11111111-1111-1111-1111-111111111111");
    expect(stored?.apiKey).toBe("sk_test_installation_key");
    expect(stored?.storePid).toBe("store_xyz");
    expect(stored?.webhookSecret).toContain("whsec_");
  });

  it("answers 401 on a bad signature and stores nothing", async () => {
    const body = installBody();
    const headers = signedHeaders("evt-install-1", NOW, body, "whsec_d3JvbmdzZWNyZXR3cm9uZ3NlY3JldHhy");
    const response = await postRaw(ctx.app, "/install", body, headers);

    expect(response.status).toBe(401);
    expect(await ctx.store.getInstallation("11111111-1111-1111-1111-111111111111")).toBeNull();
  });

  it("answers 409 on a replayed delivery id (non-2xx, so Queek treats it as failed)", async () => {
    const body = installBody();
    const headers = signedHeaders("evt-install-1", NOW, body, APP_SECRET);
    expect((await postRaw(ctx.app, "/install", body, headers)).status).toBe(200);
    expect((await postRaw(ctx.app, "/install", body, headers)).status).toBe(409);
  });

  it("answers 401 on a stale timestamp", async () => {
    const body = installBody();
    const headers = signedHeaders("evt-install-1", NOW - 3600, body, APP_SECRET);
    expect((await postRaw(ctx.app, "/install", body, headers)).status).toBe(401);
  });

  it("answers 500 when the store write fails — and leaves the id unmarked so a retry can land", async () => {
    const failing = setup({
      onInstall: async () => {
        throw new Error("disk on fire");
      },
    });
    const body = installBody();
    const headers = signedHeaders("evt-install-1", NOW, body, APP_SECRET);
    expect((await postRaw(failing.app, "/install", body, headers)).status).toBe(500);
    expect(await failing.store.hasSeenWebhookId("evt-install-1")).toBe(false);
  });

  it("answers 400 when the event type does not belong on the route", async () => {
    const body = JSON.stringify({
      id: "evt-x",
      type: "app/uninstalled",
      api_version: "v1",
      created_at: "x",
      data: {},
    });
    const response = await postRaw(ctx.app, "/install", body, signedHeaders("evt-x", NOW, body, APP_SECRET));
    expect(response.status).toBe(400);
  });

  it("uninstall deletes the installation", async () => {
    const install = installBody();
    await postRaw(ctx.app, "/install", install, signedHeaders("evt-install-1", NOW, install, APP_SECRET));

    const body = JSON.stringify({
      id: "evt-uninstall-1",
      type: "app/uninstalled",
      api_version: "v1",
      created_at: "2026-09-24T00:00:00+00:00",
      data: {
        installation: { id: "11111111-1111-1111-1111-111111111111", p_id: "inst_abc123" },
        store: { id: "22222222-2222-2222-2222-222222222222", p_id: "store_xyz", name: "Test", is_test: true },
      },
    });
    const response = await postRaw(
      ctx.app,
      "/uninstall",
      body,
      signedHeaders("evt-uninstall-1", NOW, body, APP_SECRET),
    );
    expect(response.status).toBe(200);
    expect(await ctx.store.getInstallation("11111111-1111-1111-1111-111111111111")).toBeNull();
  });

  it("settings merges into the stored installation, 404s on unknown installations", async () => {
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
        await postRaw(
          ctx.app,
          "/settings",
          missing,
          signedHeaders("evt-settings-0", NOW, missing, APP_SECRET),
        )
      ).status,
    ).toBe(404);

    const install = installBody();
    await postRaw(ctx.app, "/install", install, signedHeaders("evt-install-1", NOW, install, APP_SECRET));
    const body = JSON.stringify({
      id: "evt-settings-1",
      type: "app/settings_updated",
      api_version: "v1",
      created_at: "2026-09-24T00:00:00+00:00",
      data: {
        installation: { id: "11111111-1111-1111-1111-111111111111", p_id: "inst_abc123" },
        store: null,
        settings: { color: "red" },
      },
    });
    expect(
      (await postRaw(ctx.app, "/settings", body, signedHeaders("evt-settings-1", NOW, body, APP_SECRET)))
        .status,
    ).toBe(200);
    expect((await ctx.store.getInstallation("11111111-1111-1111-1111-111111111111"))?.settings).toEqual({
      color: "red",
    });
  });
});
