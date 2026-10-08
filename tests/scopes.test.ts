import { beforeEach, describe, expect, it } from "vitest";
import { UnknownInstallationError } from "../src/app-auth.js";
import { createInstallHandlers } from "../src/hono.js";
import { buildInstallationRecord } from "../src/install-handlers.js";
import {
  AppScopeRequiredError,
  createInstallationScopesClient,
  InvalidScopesError,
  normaliseScopeList,
  splitInstallationScopes,
} from "../src/scopes.js";
import { type InstallationRecord, SqliteInstallationStore } from "../src/store.js";
import { fakeSecret, installBody, postRaw, scopesUpdateBody, signedHeaders } from "./helpers.js";

const APP_SECRET = fakeSecret("scopes-app");
const STORE_KEY = Buffer.alloc(32, 7).toString("base64");
const NOW = 1758685600;

const INSTALLATION_ID = "11111111-1111-1111-1111-111111111111";
const REQUIRED = "merchant-business_profile-read";
const OPTIONAL_A = "merchant-orders-read";
const OPTIONAL_B = "merchant-products-read";

function setup() {
  const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
  const app = createInstallHandlers({ appSecret: APP_SECRET, store, nowSeconds: NOW });
  return { store, app };
}

/** Seed one installed row via the install mapping (grant = [REQUIRED]). */
async function seedInstalled(store: SqliteInstallationStore): Promise<InstallationRecord> {
  const parsed = JSON.parse(installBody({ scopes: [REQUIRED] })) as {
    data: Parameters<typeof buildInstallationRecord>[0];
  };
  const record = buildInstallationRecord(parsed.data);
  await store.saveInstallation(record);
  return record;
}

async function seedWithToken(store: SqliteInstallationStore): Promise<InstallationRecord> {
  const record = await seedInstalled(store);
  const withToken: InstallationRecord = {
    ...record,
    token: "tok_old",
    tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    tokenKid: "kid-1",
  };
  await store.saveInstallation(withToken);
  return withToken;
}

describe("scopes_update handoff", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("refreshes the cached grant and drops the cached token on a valid handoff", async () => {
    await seedWithToken(ctx.store);
    const body = scopesUpdateBody({ scopes: [REQUIRED, OPTIONAL_A] });
    const response = await postRaw(
      ctx.app,
      "/install",
      body,
      signedHeaders("evt-scopes-1", NOW, body, APP_SECRET),
    );

    expect(response.status).toBe(200);
    const stored = await ctx.store.getInstallation(INSTALLATION_ID);
    expect(stored?.scopes).toEqual([REQUIRED, OPTIONAL_A]);
    expect(stored?.token).toBeNull();
    expect(stored?.tokenExpiresAt).toBeNull();
    expect(stored?.tokenKid).toBeNull();
    // A grant handoff refreshes nothing else.
    expect(stored?.storeName).toBe("Test Store");
  });

  it("keeps the cached token when the grant is unchanged", async () => {
    await seedWithToken(ctx.store);
    const existing = await ctx.store.getInstallation(INSTALLATION_ID);
    const body = scopesUpdateBody({ scopes: existing?.scopes ?? [] });
    const response = await postRaw(
      ctx.app,
      "/install",
      body,
      signedHeaders("evt-scopes-2", NOW, body, APP_SECRET),
    );

    expect(response.status).toBe(200);
    expect((await ctx.store.getInstallation(INSTALLATION_ID))?.token).toBe("tok_old");
  });

  it("answers 401 on a bad signature and keeps the cached grant", async () => {
    await seedWithToken(ctx.store);
    const body = scopesUpdateBody();
    const other = fakeSecret("wrong");
    const response = await postRaw(
      ctx.app,
      "/install",
      body,
      signedHeaders("evt-scopes-3", NOW, body, other),
    );

    expect(response.status).toBe(401);
    const stored = await ctx.store.getInstallation(INSTALLATION_ID);
    expect(stored?.scopes).toEqual([REQUIRED]);
    expect(stored?.token).toBe("tok_old");
  });

  it("answers 409 on a replayed delivery id", async () => {
    await seedInstalled(ctx.store);
    const body = scopesUpdateBody();
    const headers = signedHeaders("evt-scopes-1", NOW, body, APP_SECRET);
    expect((await postRaw(ctx.app, "/install", body, headers)).status).toBe(200);
    expect((await postRaw(ctx.app, "/install", body, headers)).status).toBe(409);
  });

  it("answers 404 for an unknown p_id and leaves the id unmarked so a retry can land", async () => {
    const body = scopesUpdateBody({ installation: { p_id: "nope_missing" } });
    const response = await postRaw(
      ctx.app,
      "/install",
      body,
      signedHeaders("evt-scopes-9", NOW, body, APP_SECRET),
    );

    expect(response.status).toBe(404);
    expect(await ctx.store.hasSeenWebhookId("evt-scopes-9")).toBe(false);
  });

  it("is accepted on the settings route too (Queek aims at settings_url first)", async () => {
    await seedWithToken(ctx.store);
    const body = scopesUpdateBody({ scopes: [REQUIRED, OPTIONAL_A] });
    const response = await postRaw(
      ctx.app,
      "/settings",
      body,
      signedHeaders("evt-scopes-4", NOW, body, APP_SECRET),
    );

    expect(response.status).toBe(200);
    const stored = await ctx.store.getInstallation(INSTALLATION_ID);
    expect(stored?.scopes).toEqual([REQUIRED, OPTIONAL_A]);
    expect(stored?.token).toBeNull();
  });

  it("tolerates a JSON-integer p_id against a string row", async () => {
    const record = await seedInstalled(ctx.store);
    await ctx.store.saveInstallation({ ...record, installationPid: "1021" });
    const body = scopesUpdateBody({ installation: { p_id: 1021 }, scopes: [REQUIRED, OPTIONAL_A] });
    const response = await postRaw(
      ctx.app,
      "/install",
      body,
      signedHeaders("evt-scopes-5", NOW, body, APP_SECRET),
    );

    expect(response.status).toBe(200);
    expect((await ctx.store.getInstallation(INSTALLATION_ID))?.scopes).toEqual([REQUIRED, OPTIONAL_A]);
  });

  it("matches a string p_id against the same row", async () => {
    const record = await seedInstalled(ctx.store);
    await ctx.store.saveInstallation({ ...record, installationPid: "1021" });
    const body = scopesUpdateBody({ installation: { p_id: "1021" }, scopes: [REQUIRED] });
    const response = await postRaw(
      ctx.app,
      "/install",
      body,
      signedHeaders("evt-scopes-6", NOW, body, APP_SECRET),
    );

    expect(response.status).toBe(200);
    expect((await ctx.store.getInstallation(INSTALLATION_ID))?.scopes).toEqual([REQUIRED]);
  });

  it("answers 400 for a scopes_update with a non-array grant", async () => {
    await seedInstalled(ctx.store);
    const body = scopesUpdateBody({ scopes: "merchant-orders-read" });
    const response = await postRaw(
      ctx.app,
      "/install",
      body,
      signedHeaders("evt-scopes-7", NOW, body, APP_SECRET),
    );

    expect(response.status).toBe(400);
  });
});

function clientSetup(
  opts: {
    fetchImpl?: typeof fetch;
    appSlug?: string;
    optionalScopes?: string[];
    dashboardOrigin?: string;
  } = {},
) {
  const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
  const fetchImpl =
    opts.fetchImpl ??
    (() => {
      throw new Error("queryScopes/requestScopes must never fetch");
    });
  const client = createInstallationScopesClient({
    installationId: INSTALLATION_ID,
    store,
    signJwt: () => "test-app-jwt",
    fetchImpl,
    appSlug: opts.appSlug ?? "test-app",
    optionalScopes: opts.optionalScopes ?? [OPTIONAL_A, OPTIONAL_B],
    dashboardOrigin: opts.dashboardOrigin,
  });
  return { store, client };
}

describe("queryScopes", () => {
  it("returns the cached granted + declared-optional split without any fetch", async () => {
    const { store, client } = clientSetup();
    await seedWithToken(store);

    const seen = await client.queryScopes();

    expect(seen).toEqual({ granted: [REQUIRED], optional: [] });
  });

  it("splits granted optional scopes in granted order", async () => {
    const { store, client } = clientSetup();
    const record = await seedInstalled(store);
    await store.saveInstallation({ ...record, scopes: [OPTIONAL_B, REQUIRED, OPTIONAL_A] });

    await expect(client.queryScopes()).resolves.toEqual({
      granted: [OPTIONAL_B, REQUIRED, OPTIONAL_A],
      optional: [OPTIONAL_B, OPTIONAL_A],
    });
  });

  it("prefers the per-call declared list over the client option", async () => {
    const { store, client } = clientSetup();
    const record = await seedInstalled(store);
    await store.saveInstallation({ ...record, scopes: [REQUIRED, OPTIONAL_A] });

    await expect(client.queryScopes({ optionalScopes: [OPTIONAL_B] })).resolves.toEqual({
      granted: [REQUIRED, OPTIONAL_A],
      optional: [],
    });
  });

  it("throws for an unknown installation without fetching", async () => {
    const { client } = clientSetup();
    await expect(client.queryScopes()).rejects.toBeInstanceOf(UnknownInstallationError);
  });

  it("refuses construction without a store or signer", () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    expect(() =>
      createInstallationScopesClient({
        installationId: INSTALLATION_ID,
        store: undefined as never,
        signJwt: () => "x",
      }),
    ).toThrow(InvalidScopesError);
    expect(() =>
      createInstallationScopesClient({
        installationId: INSTALLATION_ID,
        store,
        signJwt: undefined as never,
      }),
    ).toThrow(InvalidScopesError);
  });
});

describe("requestScopes", () => {
  it("builds the dashboard-relative consent link (the AppsPage query route)", () => {
    const { client } = clientSetup();
    expect(client.requestScopes([OPTIONAL_A, OPTIONAL_B])).toBe(
      `/apps?app=test-app&view=scopes&scopes=${OPTIONAL_A},${OPTIONAL_B}`,
    );
  });

  it("builds an absolute link under the dashboard origin", () => {
    const { client } = clientSetup({ dashboardOrigin: "https://dashboard.usequeek.com" });
    expect(client.requestScopes([OPTIONAL_A])).toBe(
      `https://dashboard.usequeek.com/apps?app=test-app&view=scopes&scopes=${OPTIONAL_A}`,
    );
  });

  it("normalises the requested scopes and honours the per-call slug", () => {
    const { client } = clientSetup();
    expect(client.requestScopes([` ${OPTIONAL_A} `, OPTIONAL_A], { appSlug: "other-app" })).toBe(
      `/apps?app=other-app&view=scopes&scopes=${OPTIONAL_A}`,
    );
  });

  it("refuses an empty scope list before building anything", () => {
    const { client } = clientSetup();
    expect(() => client.requestScopes([])).toThrow(InvalidScopesError);
  });

  it("refuses without an app slug (per-call slug still works)", () => {
    const slugless = createInstallationScopesClient({
      installationId: INSTALLATION_ID,
      store: new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY }),
      signJwt: () => "test-app-jwt",
    });
    expect(() => slugless.requestScopes([OPTIONAL_A])).toThrow(InvalidScopesError);
    expect(slugless.requestScopes([OPTIONAL_A], { appSlug: "late-slug" })).toContain(
      "/apps?app=late-slug&view=scopes",
    );
  });
});

describe("revokeScopes", () => {
  function revokeSetup(
    respond: (url: string, init: RequestInit) => Response,
    seenRequests: Array<{ url: string; init: RequestInit }> = [],
  ) {
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenRequests.push({ url, init });
      return respond(url, init);
    }) as typeof fetch;
    const { store, client } = clientSetup({ fetchImpl });
    return { store, client, seenRequests };
  }

  const okRevoke = (scopes: string[]) =>
    new Response(JSON.stringify({ installation: { p_id: "inst_abc123" }, scopes }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("posts the app-authenticated revoke, refreshes the cache, and drops the token", async () => {
    const { store, client, seenRequests } = revokeSetup((_url, _init) => okRevoke([REQUIRED]));
    await seedWithToken(store);
    // The row must carry the optional scope first for the shrink to show.
    const existing = await store.getInstallation(INSTALLATION_ID);
    if (!existing) throw new Error("seed missing");
    await store.saveInstallation({ ...existing, scopes: [REQUIRED, OPTIONAL_A] });

    const updated = await client.revokeScopes([OPTIONAL_A]);

    expect(updated).toEqual([REQUIRED]);
    expect(seenRequests).toHaveLength(1);
    const [call] = seenRequests;
    expect(call.url).toBe(
      `https://api.usequeek.com/api/v1/apps/installations/${INSTALLATION_ID}/scopes/revoke`,
    );
    expect(call.init.method).toBe("POST");
    const headers = new Headers(call.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-app-jwt");
    expect(headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(call.init.body))).toEqual({ scopes: [OPTIONAL_A] });
    const stored = await store.getInstallation(INSTALLATION_ID);
    expect(stored?.scopes).toEqual([REQUIRED]);
    expect(stored?.token).toBeNull();
  });

  it("reuses a caller-supplied idempotency key", async () => {
    const { store, client, seenRequests } = revokeSetup((_url, _init) => okRevoke([REQUIRED]));
    await seedInstalled(store);

    await client.revokeScopes([OPTIONAL_A], { idempotencyKey: "key-123" });

    expect(new Headers(seenRequests[0]?.init.headers).get("Idempotency-Key")).toBe("key-123");
  });

  it("surfaces 422 app_scope_required as a typed error and keeps the cache", async () => {
    // The body mirrors Queek's error shape exactly: legacy top-level keys
    // plus the `error` envelope, with the per-field detail at
    // `error.errors`.
    const { store, client } = revokeSetup(
      (_url, _init) =>
        new Response(
          JSON.stringify({
            status: "failed",
            error_code: "app_scope_required",
            message: "These scopes are required and cannot be revoked.",
            data: null,
            errors: { scopes: [REQUIRED] },
            error: {
              code: "app_scope_required",
              message: "These scopes are required and cannot be revoked.",
              field: "scopes",
              errors: { scopes: [REQUIRED] },
              doc_url: "https://docs.usequeek.com/errors#app_scope_required",
              request_id: "req_test_scopes_1",
            },
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        ),
    );
    await seedWithToken(store);

    const failure = await client.revokeScopes([REQUIRED]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppScopeRequiredError);
    expect((failure as AppScopeRequiredError).code).toBe("app_scope_required");
    expect((failure as AppScopeRequiredError).scopes).toEqual([REQUIRED]);
    const stored = await store.getInstallation(INSTALLATION_ID);
    expect(stored?.scopes).toEqual([REQUIRED]);
    expect(stored?.token).toBe("tok_old");
  });

  it("treats revoke of a never-granted scope as idempotent 200 and keeps the token", async () => {
    const { store, client } = revokeSetup((_url, _init) => okRevoke([REQUIRED]));
    await seedWithToken(store);

    // Same compare-and-clear as the scopes_update handler: the returned
    // grant equals the cached one, so the cached token still matches live.
    await expect(client.revokeScopes([OPTIONAL_B])).resolves.toEqual([REQUIRED]);
    expect((await store.getInstallation(INSTALLATION_ID))?.token).toBe("tok_old");
  });

  it("purges the local row on 404 app_installation_gone", async () => {
    const { store, client } = revokeSetup(
      (_url, _init) =>
        new Response(JSON.stringify({ error: { code: "app_installation_gone", message: "Gone." } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await seedInstalled(store);

    await expect(client.revokeScopes([OPTIONAL_A])).rejects.toMatchObject({
      status: 404,
      code: "app_installation_gone",
    });
    expect(await store.getInstallation(INSTALLATION_ID)).toBeNull();
  });

  it("propagates a network failure as network_error without touching the cache", async () => {
    const { store, client } = clientSetup({
      fetchImpl: (async () => {
        throw new Error("down");
      }) as typeof fetch,
    });
    await seedWithToken(store);

    await expect(client.revokeScopes([OPTIONAL_A])).rejects.toMatchObject({
      code: "network_error",
    });
    expect((await store.getInstallation(INSTALLATION_ID))?.token).toBe("tok_old");
  });
});

describe("scope list validation", () => {
  it("trims, drops empties, and dedupes", () => {
    expect(normaliseScopeList([" b ", "a", "b", "  "])).toEqual(["b", "a"]);
  });

  it("rejects non-arrays, non-strings, empties, and oversize lists", () => {
    expect(() => normaliseScopeList("x")).toThrow(InvalidScopesError);
    expect(() => normaliseScopeList([42])).toThrow(InvalidScopesError);
    expect(() => normaliseScopeList([])).toThrow(InvalidScopesError);
    expect(() => normaliseScopeList(["  "])).toThrow(InvalidScopesError);
    expect(() => normaliseScopeList(Array.from({ length: 51 }, (_, i) => `scope-${i}`))).toThrow(
      InvalidScopesError,
    );
  });

  it("splits granted against the declared list in granted order", () => {
    expect(splitInstallationScopes(["b", "a"], ["a"])).toEqual({ granted: ["b", "a"], optional: ["a"] });
    expect(splitInstallationScopes(["b"], [])).toEqual({ granted: ["b"], optional: [] });
  });
});
