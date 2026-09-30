import { beforeEach, describe, expect, it } from "vitest";
import { createInstallHandlers } from "../src/hono.js";
import { SqliteInstallationStore } from "../src/store.js";
import { fakeEmbedSecret, fakeSecret, installBody, postRaw, resyncBody, signedHeaders } from "./helpers.js";

const APP_SECRET = fakeSecret("app-signing");
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
    // S4: the embed secret + app id that verify dashboard session tokens.
    expect(stored?.embedSecret).toContain("embsec_");
    expect(stored?.appId).toBe("app-uuid-hello");
  });

  it("answers 401 on a bad signature and stores nothing", async () => {
    const body = installBody();
    const headers = signedHeaders("evt-install-1", NOW, body, fakeSecret("wrong"));
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

describe("platform resync handoff (type app/resync)", () => {
  const INSTALLATION_ID = "11111111-1111-1111-1111-111111111111";

  async function installFirst(ctx: ReturnType<typeof setup>) {
    const install = installBody();
    expect(
      (await postRaw(ctx.app, "/install", install, signedHeaders("evt-install-1", NOW, install, APP_SECRET)))
        .status,
    ).toBe(200);
    const before = await ctx.store.getInstallation(INSTALLATION_ID);
    if (!before) throw new Error("expected the install to be stored");
    // A minted token is cached before the resync lands.
    await ctx.store.saveInstallation({
      ...before,
      token: "tok_cached_before_resync",
      tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      tokenKid: "kid-1",
      updatedAt: new Date().toISOString(),
    });
    return before;
  }

  it("/install accepts a resync for an existing row and restores a lost embed_secret/app_id", async () => {
    const ctx = setup();
    const before = await installFirst(ctx);

    // The outage wiped the S4 keys from the row; the resync restores them.
    const wiped = await ctx.store.getInstallation(INSTALLATION_ID);
    if (!wiped) throw new Error("expected the install to be stored");
    await ctx.store.saveInstallation({ ...wiped, embedSecret: null, appId: null });

    const body = resyncBody({
      webhook_secret: fakeSecret("rotated-secret-after-resync"),
      proxy_secret: fakeSecret("proxy-after-resync"),
      embed_secret: fakeEmbedSecret("restored-after-resync"),
      app_id: "app-uuid-restored",
    });
    const response = await postRaw(
      ctx.app,
      "/install",
      body,
      signedHeaders("evt-resync-1", NOW, body, APP_SECRET),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const after = await ctx.store.getInstallation(INSTALLATION_ID);
    expect(after?.webhookSecret).toBe(fakeSecret("rotated-secret-after-resync"));
    expect(after?.proxySecret).toBe(fakeSecret("proxy-after-resync"));
    expect(after?.embedSecret).toBe(fakeEmbedSecret("restored-after-resync"));
    expect(after?.appId).toBe("app-uuid-restored");
    expect(after?.settings).toEqual({ greeting: "resynced" });
    expect(after?.installedAt).toBe(before?.installedAt);
    expect(after?.token).toBe("tok_cached_before_resync");
    expect(after?.tokenKid).toBe("kid-1");
  });

  it("/install creates the row when the resync finds nothing stored", async () => {
    const ctx = setup();
    const body = resyncBody();
    const response = await postRaw(
      ctx.app,
      "/install",
      body,
      signedHeaders("evt-resync-1", NOW, body, APP_SECRET),
    );
    expect(response.status).toBe(200);
    const stored = await ctx.store.getInstallation(INSTALLATION_ID);
    expect(stored?.webhookSecret).toContain("whsec_");
    expect(stored?.embedSecret).toContain("embsec_");
    expect(stored?.appId).toBe("app-uuid-hello");
  });

  it("/install refuses a resync with a bad signature and stores nothing", async () => {
    const ctx = setup();
    const body = resyncBody();
    const headers = signedHeaders("evt-resync-1", NOW, body, fakeSecret("wrong"));
    expect((await postRaw(ctx.app, "/install", body, headers)).status).toBe(401);
    expect(await ctx.store.getInstallation(INSTALLATION_ID)).toBeNull();
  });

  it("/settings accepts a resync: secrets + settings refresh, installedAt and cached token kept", async () => {
    const ctx = setup();
    const before = await installFirst(ctx);

    const body = resyncBody({
      webhook_secret: fakeSecret("rotated-via-settings"),
      proxy_secret: fakeSecret("proxy-via-settings"),
      embed_secret: fakeEmbedSecret("via-settings"),
      app_id: "app-uuid-via-settings",
      settings: { color: "resynced-blue" },
    });
    const response = await postRaw(
      ctx.app,
      "/settings",
      body,
      signedHeaders("evt-resync-9", NOW, body, APP_SECRET),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const after = await ctx.store.getInstallation(INSTALLATION_ID);
    expect(after?.webhookSecret).toBe(fakeSecret("rotated-via-settings"));
    expect(after?.proxySecret).toBe(fakeSecret("proxy-via-settings"));
    expect(after?.embedSecret).toBe(fakeEmbedSecret("via-settings"));
    expect(after?.appId).toBe("app-uuid-via-settings");
    expect(after?.settings).toEqual({ color: "resynced-blue" });
    expect(after?.installedAt).toBe(before?.installedAt);
    expect(after?.token).toBe("tok_cached_before_resync");
  });

  it("/settings creates the row when the resync finds nothing stored", async () => {
    const ctx = setup();
    const body = resyncBody();
    const response = await postRaw(
      ctx.app,
      "/settings",
      body,
      signedHeaders("evt-resync-1", NOW, body, APP_SECRET),
    );
    expect(response.status).toBe(200);
    expect((await ctx.store.getInstallation(INSTALLATION_ID))?.appId).toBe("app-uuid-hello");
  });

  it("/settings keeps stored values the resync omits and refuses a bad signature", async () => {
    const ctx = setup();
    await installFirst(ctx);

    const parsed = JSON.parse(resyncBody()) as { id: string; data: Record<string, unknown> };
    delete parsed.data.embed_secret;
    delete parsed.data.app_id;
    parsed.id = "evt-resync-omit";
    const omitted = JSON.stringify(parsed);
    expect(
      (
        await postRaw(
          ctx.app,
          "/settings",
          omitted,
          signedHeaders("evt-resync-omit", NOW, omitted, APP_SECRET),
        )
      ).status,
    ).toBe(200);
    const kept = await ctx.store.getInstallation(INSTALLATION_ID);
    expect(kept?.embedSecret).toContain("embsec_");
    expect(kept?.appId).toBe("app-uuid-hello");

    const forged = resyncBody();
    expect(
      (
        await postRaw(
          ctx.app,
          "/settings",
          forged,
          signedHeaders("evt-resync-bad", NOW, forged, fakeSecret("wrong")),
        )
      ).status,
    ).toBe(401);
  });

  it("both routes still refuse an unknown event type", async () => {
    const ctx = setup();
    for (const path of ["/install", "/settings"]) {
      const body = JSON.stringify({
        id: "evt-unknown",
        type: "app/deleted",
        api_version: "v1",
        created_at: "2026-09-25T00:00:00+00:00",
        data: {},
      });
      const response = await postRaw(
        ctx.app,
        path,
        body,
        signedHeaders(`evt-unknown-${path}`, NOW, body, APP_SECRET),
      );
      expect(response.status).toBe(400);
    }
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
        webhook_secret: fakeSecret("rotated-secret-after-resync"),
        proxy_secret: fakeSecret("proxy-after-resync"),
        embed_secret: fakeEmbedSecret("after-resync"),
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
    expect(after?.webhookSecret).toBe(fakeSecret("rotated-secret-after-resync"));
    expect(after?.proxySecret).toBe(fakeSecret("proxy-after-resync"));
    expect(after?.embedSecret).toBe(fakeEmbedSecret("after-resync"));
    expect(after?.appId).toBe("app-uuid-hello");
    expect(after?.settings).toEqual({ greeting: "rotated" });
    expect(after?.installedAt).toBe(before?.installedAt);
    expect(after?.token).toBe("tok_cached_before_resync");
    expect(after?.tokenKid).toBe("kid-1");

    // A handoff that omits the S4 keys (older payload) keeps what is stored.
    const older = JSON.parse(resync) as { id: string; data: Record<string, unknown> };
    delete older.data.embed_secret;
    delete older.data.app_id;
    older.id = "evt-resync-8";
    const olderBody = JSON.stringify(older);
    const kept = await postRaw(
      app,
      "/install",
      olderBody,
      signedHeaders("evt-resync-8", NOW, olderBody, APP_SECRET),
    );
    expect(kept.status).toBe(200);
    const afterOlder = await store.getInstallation("11111111-1111-1111-1111-111111111111");
    expect(afterOlder?.embedSecret).toBe(fakeEmbedSecret("after-resync"));
    expect(afterOlder?.appId).toBe("app-uuid-hello");
  });
});

describe("grant change drops the cached installation token", () => {
  const INSTALLATION_ID = "11111111-1111-1111-1111-111111111111";

  async function installWithToken(
    ctx: ReturnType<typeof setup>,
    scopes: string[] = ["merchant-business_profile-read"],
  ) {
    const install = installBody({ scopes });
    expect(
      (await postRaw(ctx.app, "/install", install, signedHeaders("evt-install-1", NOW, install, APP_SECRET)))
        .status,
    ).toBe(200);
    const before = await ctx.store.getInstallation(INSTALLATION_ID);
    if (!before) throw new Error("expected the install to be stored");
    await ctx.store.saveInstallation({
      ...before,
      token: "tok_old_scope",
      tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      tokenKid: "kid-1",
      updatedAt: new Date().toISOString(),
    });
  }

  it("a resync with new scopes drops the cached token so the next call re-mints", async () => {
    const ctx = setup();
    await installWithToken(ctx);

    const body = resyncBody({ scopes: ["merchant-business_profile-read", "merchant-items-detail"] });
    const response = await postRaw(
      ctx.app,
      "/install",
      body,
      signedHeaders("evt-resync-scopes", NOW, body, APP_SECRET),
    );
    expect(response.status).toBe(200);
    const after = await ctx.store.getInstallation(INSTALLATION_ID);
    expect(after?.scopes).toEqual(["merchant-business_profile-read", "merchant-items-detail"]);
    expect(after?.token).toBeNull();
    expect(after?.tokenExpiresAt).toBeNull();
    expect(after?.tokenKid).toBeNull();
  });

  it("a resync with unchanged scopes keeps the cached token", async () => {
    const ctx = setup();
    await installWithToken(ctx);

    const body = resyncBody({ scopes: ["merchant-business_profile-read"] });
    const response = await postRaw(
      ctx.app,
      "/install",
      body,
      signedHeaders("evt-resync-same", NOW, body, APP_SECRET),
    );
    expect(response.status).toBe(200);
    const after = await ctx.store.getInstallation(INSTALLATION_ID);
    expect(after?.token).toBe("tok_old_scope");
    expect(after?.tokenKid).toBe("kid-1");
  });

  it("a re-install (re-grant) with new scopes drops the cached token", async () => {
    const ctx = setup();
    await installWithToken(ctx);

    const parsed = JSON.parse(installBody()) as { data: Record<string, unknown> };
    const regrant = JSON.stringify({
      id: "evt-regrant-1",
      type: "app/installed",
      api_version: "v1",
      created_at: "2026-09-30T00:00:00+00:00",
      data: {
        ...(parsed.data as object),
        scopes: ["merchant-business_profile-read", "merchant-items-detail"],
      },
    });
    const response = await postRaw(
      ctx.app,
      "/install",
      regrant,
      signedHeaders("evt-regrant-1", NOW, regrant, APP_SECRET),
    );
    expect(response.status).toBe(200);
    const after = await ctx.store.getInstallation(INSTALLATION_ID);
    expect(after?.scopes).toEqual(["merchant-business_profile-read", "merchant-items-detail"]);
    expect(after?.token).toBeNull();
  });
});
