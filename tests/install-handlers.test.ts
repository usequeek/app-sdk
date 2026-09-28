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
    // No credential crosses the handoff: the row caches no token (the
    // first API call mints one) but holds the secret + settings.
    expect(stored?.token).toBeNull();
    expect(stored?.tokenExpiresAt).toBeNull();
    expect(stored?.storePid).toBe("store_xyz");
    expect(stored?.webhookSecret).toContain("whsec_");
    expect(stored?.proxySecret).toContain("whsec_");
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

  it("rejects replays on uninstall and settings too (same header id, all three routes)", async () => {
    const install = installBody();
    await postRaw(ctx.app, "/install", install, signedHeaders("evt-install-1", NOW, install, APP_SECRET));

    const uninstall = JSON.stringify({
      id: "evt-uninstall-1",
      type: "app/uninstalled",
      api_version: "v1",
      created_at: "2026-09-24T00:00:00+00:00",
      data: {
        installation: { id: "11111111-1111-1111-1111-111111111111", p_id: "inst_abc123" },
        store: { id: "22222222-2222-2222-2222-222222222222", p_id: "store_xyz", name: "Test", is_test: true },
      },
    });
    const uninstallHeaders = signedHeaders("evt-uninstall-1", NOW, uninstall, APP_SECRET);
    expect((await postRaw(ctx.app, "/uninstall", uninstall, uninstallHeaders)).status).toBe(200);
    expect((await postRaw(ctx.app, "/uninstall", uninstall, uninstallHeaders)).status).toBe(409);

    const settings = JSON.stringify({
      id: "evt-settings-9",
      type: "app/settings_updated",
      api_version: "v1",
      created_at: "2026-09-24T00:00:00+00:00",
      data: {
        installation: { id: "11111111-1111-1111-1111-111111111111", p_id: "inst_abc123" },
        store: null,
        settings: { color: "blue" },
      },
    });
    // Re-install (fresh header id) so settings has a stored row to merge into.
    const reinstall = installBody();
    await postRaw(ctx.app, "/install", reinstall, signedHeaders("evt-install-2", NOW, reinstall, APP_SECRET));
    const settingsHeaders = signedHeaders("evt-settings-9", NOW, settings, APP_SECRET);
    expect((await postRaw(ctx.app, "/settings", settings, settingsHeaders)).status).toBe(200);
    expect((await postRaw(ctx.app, "/settings", settings, settingsHeaders)).status).toBe(409);
  });

  it("guards on the HEADER id even when the body id differs", async () => {
    const bodyOne = installBody();
    const headerId = "hdr-1";
    expect(
      (await postRaw(ctx.app, "/install", bodyOne, signedHeaders(headerId, NOW, bodyOne, APP_SECRET))).status,
    ).toBe(200);
    // Same header id, different body id: the signature still verifies
    // (it covers the header id), but the claimed header id rejects it.
    const bodyTwo = JSON.stringify({ ...JSON.parse(bodyOne), id: "body-2" });
    expect(
      (await postRaw(ctx.app, "/install", bodyTwo, signedHeaders(headerId, NOW, bodyTwo, APP_SECRET))).status,
    ).toBe(409);
    // A fresh header id with the same body lands fine.
    expect(
      (await postRaw(ctx.app, "/install", bodyTwo, signedHeaders("hdr-2", NOW, bodyTwo, APP_SECRET))).status,
    ).toBe(200);
  });

  it("runs concurrent same-id installs exactly once (atomic claim)", async () => {
    const body = installBody();
    const headers = () => signedHeaders("evt-race", NOW, body, APP_SECRET);
    const statuses = await Promise.all(
      Array.from({ length: 8 }, () => postRaw(ctx.app, "/install", body, headers()).then((r) => r.status)),
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
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

  it("rejects an install payload missing its installation ref or api_base", async () => {
    for (const data of [
      { store: {}, api_base: "https://api.usequeek.com" },
      { installation: { id: "x", p_id: "y" } },
    ]) {
      const body = JSON.stringify({
        id: "evt-bad-payload",
        type: "app/installed",
        api_version: "v1",
        created_at: "2026-09-24T00:00:00+00:00",
        data,
      });
      const response = await postRaw(
        ctx.app,
        "/install",
        body,
        signedHeaders("evt-bad-payload", NOW, body, APP_SECRET),
      );
      expect(response.status).toBe(400);
    }
    expect(await ctx.store.getInstallation("x")).toBeNull();
  });
});

describe("resync delivery (install envelope for an existing installation)", () => {
  it("merges idempotently: secret + settings refresh, installedAt and cached token kept", async () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    const app = createInstallHandlers({ appSecret: APP_SECRET, store, nowSeconds: NOW });

    const install = installBody();
    expect(
      (await postRaw(app, "/install", install, signedHeaders("evt-install-1", NOW, install, APP_SECRET)))
        .status,
    ).toBe(200);
    const before = await store.getInstallation("11111111-1111-1111-1111-111111111111");
    if (!before) throw new Error("expected the install to be stored");

    // A minted token is cached before the resync lands.
    await store.saveInstallation({
      ...before,
      token: "tok_cached_before_resync",
      tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      tokenKid: "kid-1",
      updatedAt: new Date().toISOString(),
    });

    // The resync: same envelope shape, fresh header id, rotated secret.
    const parsed = JSON.parse(installBody()) as {
      data: Record<string, unknown>;
    };
    const resync = JSON.stringify({
      id: "evt-resync-7",
      type: "app/installed",
      api_version: "v1",
      created_at: "2026-09-25T00:00:00+00:00",
      data: {
        ...(parsed.data as object),
        webhook_secret: "whsec_rotated_secret_after_resync",
        proxy_secret: "whsec_proxy_after_resync",
        settings: { greeting: "rotated" },
      },
    });
    const response = await postRaw(
      app,
      "/install",
      resync,
      signedHeaders("evt-resync-7", NOW, resync, APP_SECRET),
    );
    expect(response.status).toBe(200);

    const after = await store.getInstallation("11111111-1111-1111-1111-111111111111");
    expect(after?.webhookSecret).toBe("whsec_rotated_secret_after_resync");
    expect(after?.proxySecret).toBe("whsec_proxy_after_resync");
    expect(after?.settings).toEqual({ greeting: "rotated" });
    expect(after?.installedAt).toBe(before?.installedAt);
    expect(after?.token).toBe("tok_cached_before_resync");
    expect(after?.tokenKid).toBe("kid-1");
  });
});
