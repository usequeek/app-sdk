import { describe, expect, it } from "vitest";
import {
  API_KEY_REVOKED_CODE,
  APP_INSTALLATION_PENDING_CODE,
  APP_TOKEN_REVOKED_CODE,
  AppMintHaltedError,
  INVALID_CLIENT_CODE,
  loadAppCredential,
  UnknownInstallationError,
} from "../src/app-auth.js";
import { createQueekClient, QueekApiError } from "../src/client.js";
import type { InstallData } from "../src/handoff.js";
import { saveResyncedInstallation } from "../src/install-handlers.js";
import { createLogger } from "../src/logger.js";
import {
  defaultClearCachedTokenIfMatches,
  type InstallationRecord,
  type InstallationStore,
  SqliteInstallationStore,
} from "../src/store.js";
import { AppTokenProvider, createInstallationClient, resolveAppApiBase } from "../src/tokens.js";
import { type FakeAppApi, fakeQueekAppApi, testAppKeypair } from "./fake-queek-app-api.js";

const STORE_KEY = Buffer.alloc(32, 41).toString("base64");
const API_BASE = "https://api.usequeek.com";
const INSTALLATION_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function installationRecord(overrides: Partial<InstallationRecord> = {}): InstallationRecord {
  return {
    installationId: INSTALLATION_ID,
    installationPid: "inst_abc123",
    vendorId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    storePid: "store_xyz",
    storeName: "Test Store",
    apiBase: API_BASE,
    token: null,
    tokenExpiresAt: null,
    tokenKid: null,
    pending: false,
    scopes: [],
    settings: {},
    webhookSecret: null,
    proxySecret: null,
    webhookUrl: null,
    webhookTopics: [],
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

interface Setup {
  store: SqliteInstallationStore;
  fake: FakeAppApi;
  provider: AppTokenProvider;
  lines: string[];
  sleeps: number[];
}

// One keypair per file: RSA keygen is slow, and sharing is safe (each
// fake keeps its own issued-token map; nothing secret leaves the process).
const KEYPAIR = testAppKeypair();

function setup(
  fakeOptions: Omit<Parameters<typeof fakeQueekAppApi>[0], "keypair"> = {},
  providerOptions: Partial<ConstructorParameters<typeof AppTokenProvider>[0]> = {},
): Setup {
  const keypair = KEYPAIR;
  const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
  const fake = fakeQueekAppApi({ keypair, ...fakeOptions });
  const lines: string[] = [];
  const logger = createLogger({ service: "test", sink: (line) => lines.push(line) });
  const sleeps: number[] = [];
  const provider = new AppTokenProvider({
    credential: loadAppCredential({
      appSlug: keypair.slug,
      keyId: keypair.kid,
      privateKeyPem: keypair.privateKeyPem,
    }),
    store,
    fetchImpl: fake.fetchImpl,
    logger,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    random: () => 0,
    ...providerOptions,
  });
  return { store, fake, provider, lines, sleeps };
}

function seed(ctx: Setup, overrides: Partial<InstallationRecord> = {}): void {
  ctx.store.saveInstallation(installationRecord(overrides));
}

function mintAttempts(ctx: Setup): number {
  return ctx.fake.mock.mock.calls.filter((call) => String(call[0]).includes("/access_tokens")).length;
}

function jwtShaped(line: string): boolean {
  return /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(line);
}

describe("acquireToken", () => {
  it("serves a cached-valid token with zero network calls", async () => {
    const ctx = setup();
    seed(ctx, { token: "tok_cached", tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await expect(ctx.provider.acquireToken(INSTALLATION_ID)).resolves.toBe("tok_cached");
    expect(ctx.fake.mock).not.toHaveBeenCalled();
  });

  it("re-mints when the cached token is inside the 5-minute skew (and persists kid + expiry)", async () => {
    const ctx = setup();
    seed(ctx, { token: "tok_stale", tokenExpiresAt: new Date(Date.now() + 4 * 60_000).toISOString() });
    const token = await ctx.provider.acquireToken(INSTALLATION_ID);
    expect(token).not.toBe("tok_stale");
    expect(mintAttempts(ctx)).toBe(1);
    // The fake verified the RS256 JWT (iss + window); the kid header rode along.
    expect(ctx.fake.mintCalls[0]?.kid).toBe("test-kid-1");
    const row = await ctx.store.getInstallation(INSTALLATION_ID);
    expect(row?.token).toBe(token);
    expect(row?.tokenKid).toBe("test-kid-1");
    expect(Date.parse(row?.tokenExpiresAt as string)).toBeGreaterThan(Date.now() + 30 * 60_000);
    // Second call is a cache hit: still one mint.
    await expect(ctx.provider.acquireToken(INSTALLATION_ID)).resolves.toBe(token);
    expect(mintAttempts(ctx)).toBe(1);
  });

  it("mints on a fresh install and throws UnknownInstallation for missing rows (no network)", async () => {
    const ctx = setup();
    seed(ctx);
    const token = await ctx.provider.acquireToken(INSTALLATION_ID);
    expect(token).toMatch(/^tok_1_/);
    expect(mintAttempts(ctx)).toBe(1);
    await expect(ctx.provider.acquireToken("missing-id")).rejects.toBeInstanceOf(UnknownInstallationError);
    expect(mintAttempts(ctx)).toBe(1);
  });

  it("shares one in-flight mint across concurrent callers in one process", async () => {
    const ctx = setup();
    seed(ctx);
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => ctx.provider.acquireToken(INSTALLATION_ID)),
    );
    expect(new Set(tokens).size).toBe(1);
    expect(mintAttempts(ctx)).toBe(1);
    expect(ctx.fake.mintCalls).toHaveLength(1);
  });

  it("two independent providers (two containers) minting at once: both tokens stay usable", async () => {
    // Two provider instances = two single-flight maps (the cross-container
    // case) sharing one persisted cache row; Queek keeps both minted
    // tokens valid, so neither container is locked out.
    const keypair = KEYPAIR;
    const fake = fakeQueekAppApi({ keypair });
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    store.saveInstallation(installationRecord());
    const credential = loadAppCredential({
      appSlug: keypair.slug,
      keyId: keypair.kid,
      privateKeyPem: keypair.privateKeyPem,
    });
    const silent = createLogger({ service: "test", sink: () => undefined });
    const providerOpts = {
      credential,
      store,
      fetchImpl: fake.fetchImpl,
      logger: silent,
      sleep: async () => undefined,
      random: () => 0,
    };
    const providerA = new AppTokenProvider(providerOpts);
    const providerB = new AppTokenProvider(providerOpts);
    const [tokenA, tokenB] = await Promise.all([
      providerA.acquireToken(INSTALLATION_ID),
      providerB.acquireToken(INSTALLATION_ID),
    ]);
    expect(tokenA).not.toBe(tokenB);
    expect(fake.mintCalls).toHaveLength(2);
    // No lockout: the shared row holds the winner, but the loser's token
    // is still accepted on the merchant API — prove it with the static
    // client (the installation client would re-mint through the row).
    for (const token of [tokenA, tokenB]) {
      const direct = createQueekClient({ apiBase: API_BASE, apiKey: token, fetchImpl: fake.fetchImpl });
      await expect(direct.getStore()).resolves.toMatchObject({ data: { p_id: "store_xyz" } });
    }
  });
});

describe("mint error mapping (wire contract)", () => {
  it("401 invalid_client halts minting: loud log, no retry loop, resume re-arms", async () => {
    const ctx = setup({
      mintQueue: [{ status: 401, code: INVALID_CLIENT_CODE, message: "Unknown kid." }],
    });
    seed(ctx);
    const failure = await ctx.provider.acquireToken(INSTALLATION_ID).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppMintHaltedError);
    expect((failure as AppMintHaltedError).reason).toBe(INVALID_CLIENT_CODE);
    expect(mintAttempts(ctx)).toBe(1);

    // Halted: the next acquire throws WITHOUT touching the network.
    await expect(ctx.provider.acquireToken(INSTALLATION_ID)).rejects.toBeInstanceOf(AppMintHaltedError);
    expect(mintAttempts(ctx)).toBe(1);

    // Loud log, and it carries no JWT material.
    expect(ctx.lines.join("\n")).toContain("invalid_client");
    for (const line of ctx.lines) expect(jwtShaped(line)).toBe(false);

    ctx.provider.resumeMinting();
    await expect(ctx.provider.acquireToken(INSTALLATION_ID)).resolves.toMatch(/^tok_/);
    expect(mintAttempts(ctx)).toBe(2);
  });

  it("kill-switch 403 drops ALL cached tokens and stops minting", async () => {
    const ctx = setup({
      mintQueue: [{ status: 403, code: APP_TOKEN_REVOKED_CODE, message: "App disabled." }],
    });
    const otherId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    seed(ctx, { token: "tok_keep_a", tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    seed(ctx, {
      installationId: otherId,
      installationPid: "inst_other",
      token: "tok_keep_b",
      tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    seed(ctx, { installationId: "cccccccc-cccc-cccc-cccc-cccccccccccc", installationPid: "inst_c" });

    const failure = await ctx.provider
      .acquireToken("cccccccc-cccc-cccc-cccc-cccccccccccc")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppMintHaltedError);
    expect((failure as AppMintHaltedError).reason).toBe(APP_TOKEN_REVOKED_CODE);

    // Every cached token dropped; rows survive.
    expect((await ctx.store.getInstallation(INSTALLATION_ID))?.token).toBeNull();
    expect((await ctx.store.getInstallation(otherId))?.token).toBeNull();
    expect(await ctx.store.getInstallation(INSTALLATION_ID)).not.toBeNull();
    // Minting stopped: cache-miss acquires throw without network.
    await expect(ctx.provider.acquireToken(INSTALLATION_ID)).rejects.toBeInstanceOf(AppMintHaltedError);
    expect(mintAttempts(ctx)).toBe(1);
    for (const line of ctx.lines) expect(jwtShaped(line)).toBe(false);
  });

  it("404 app_installation_gone purges the installation locally", async () => {
    const ctx = setup({
      mintQueue: [{ status: 404, code: "app_installation_gone", message: "Gone." }],
    });
    seed(ctx);
    const failure = await ctx.provider.acquireToken(INSTALLATION_ID).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueekApiError);
    expect((failure as QueekApiError).code).toBe("app_installation_gone");
    expect(await ctx.store.getInstallation(INSTALLATION_ID)).toBeNull();
    // Gone for good: the next acquire reports unknown, not a re-mint.
    await expect(ctx.provider.acquireToken(INSTALLATION_ID)).rejects.toBeInstanceOf(UnknownInstallationError);
    expect(mintAttempts(ctx)).toBe(1);
  });

  it("429 honors Retry-After with jitter, then succeeds", async () => {
    const ctx = setup({
      mintQueue: [
        { status: 429, code: "too_many_requests", headers: { "Retry-After": "2" } },
        { status: 429, code: "too_many_requests", headers: { "Retry-After": "0" } },
      ],
    });
    seed(ctx);
    await expect(ctx.provider.acquireToken(INSTALLATION_ID)).resolves.toMatch(/^tok_/);
    expect(mintAttempts(ctx)).toBe(3);
    expect(ctx.sleeps).toEqual([2000, 0]);
  });

  it("5xx backs off bounded (250, 500) and then surfaces", async () => {
    const ctx = setup({
      mintQueue: [
        { status: 500, code: "server_error" },
        { status: 503, code: "server_error" },
        { status: 500, code: "server_error" },
        { status: 500, code: "server_error" },
      ],
    });
    seed(ctx);
    const failure = await ctx.provider.acquireToken(INSTALLATION_ID).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueekApiError);
    expect(mintAttempts(ctx)).toBe(3);
    expect(ctx.sleeps).toEqual([250, 500]);
  });
});

describe("mint 409 app_installation_pending (rev 8: retry later, never purge)", () => {
  it("409 pending then 201: backs off and succeeds; the pending mark clears", async () => {
    const ctx = setup({
      mintQueue: [{ status: 409, code: APP_INSTALLATION_PENDING_CODE, message: "Pending." }],
    });
    seed(ctx);
    await expect(ctx.provider.acquireToken(INSTALLATION_ID)).resolves.toMatch(/^tok_/);
    expect(mintAttempts(ctx)).toBe(2);
    expect(ctx.sleeps).toEqual([250]);
    const row = await ctx.store.getInstallation(INSTALLATION_ID);
    expect(row?.token).toMatch(/^tok_/);
    expect(await ctx.provider.isKnownPending(INSTALLATION_ID)).toBe(false);
    expect(ctx.provider.isHalted()).toBe(false);
  });

  it("persistent 409: bounded retries, then the 409 propagates — row kept, marked, minting NOT halted", async () => {
    const ctx = setup({
      mintQueue: [
        { status: 409, code: APP_INSTALLATION_PENDING_CODE, message: "Pending." },
        { status: 409, code: APP_INSTALLATION_PENDING_CODE, message: "Pending." },
        { status: 409, code: APP_INSTALLATION_PENDING_CODE, message: "Pending." },
        { status: 409, code: APP_INSTALLATION_PENDING_CODE, message: "Pending." },
      ],
    });
    seed(ctx);
    const failure = await ctx.provider.acquireToken(INSTALLATION_ID).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueekApiError);
    expect((failure as QueekApiError).status).toBe(409);
    expect((failure as QueekApiError).code).toBe(APP_INSTALLATION_PENDING_CODE);
    // Bounded: 1 initial + 2 retries, then give up (the caller retries later).
    expect(mintAttempts(ctx)).toBe(3);
    expect(ctx.sleeps).toEqual([250, 500]);
    // NEVER purge, NEVER halt — the row survives and is marked pending so
    // resync's purge-absent step (active-only list) keeps it.
    expect(await ctx.store.getInstallation(INSTALLATION_ID)).not.toBeNull();
    expect(await ctx.provider.isKnownPending(INSTALLATION_ID)).toBe(true);
    expect(ctx.provider.isHalted()).toBe(false);
  });

  it("409 with any OTHER code propagates immediately: no retry, no pending mark", async () => {
    const ctx = setup({
      mintQueue: [{ status: 409, code: "some_future_code", message: "Something else." }],
    });
    seed(ctx);
    const failure = await ctx.provider.acquireToken(INSTALLATION_ID).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueekApiError);
    expect((failure as QueekApiError).code).toBe("some_future_code");
    expect(mintAttempts(ctx)).toBe(1);
    expect(ctx.sleeps).toEqual([]);
    expect(await ctx.provider.isKnownPending(INSTALLATION_ID)).toBe(false);
    expect(await ctx.store.getInstallation(INSTALLATION_ID)).not.toBeNull();
  });
});

describe("installation client (every call through acquireToken)", () => {
  it("sends the minted token as X-Client-Key", async () => {
    const ctx = setup();
    seed(ctx);
    const client = createInstallationClient({
      installationId: INSTALLATION_ID,
      apiBase: API_BASE,
      tokens: ctx.provider,
      fetchImpl: ctx.fake.fetchImpl,
    });
    await expect(client.getStore()).resolves.toMatchObject({ data: { p_id: "store_xyz" } });
    expect(ctx.fake.merchantCalls).toHaveLength(1);
    expect(ctx.fake.merchantCalls[0]?.clientKey).toBe(ctx.fake.mintCalls[0]?.token);
  });

  it("merchant 401: drops the token, re-mints once, retries — then succeeds with the fresh token", async () => {
    const ctx = setup({
      merchantQueue: [{ status: 401, code: "invalid_client_key", message: "Stale." }],
    });
    seed(ctx);
    const client = createInstallationClient({
      installationId: INSTALLATION_ID,
      apiBase: API_BASE,
      tokens: ctx.provider,
      fetchImpl: ctx.fake.fetchImpl,
    });
    await expect(client.getStore()).resolves.toMatchObject({ data: { p_id: "store_xyz" } });
    expect(mintAttempts(ctx)).toBe(2);
    expect(ctx.fake.merchantCalls).toHaveLength(2);
    const [first, second] = ctx.fake.merchantCalls;
    expect(first?.clientKey).not.toBe(second?.clientKey);
    expect(second?.clientKey).toBe(ctx.fake.mintCalls[1]?.token);
  });

  it("merchant 401 twice: re-mints once, then the second refusal propagates", async () => {
    const ctx = setup({
      merchantQueue: [
        { status: 401, code: "invalid_client_key", message: "Stale." },
        { status: 401, code: "invalid_client_key", message: "Still stale." },
      ],
    });
    seed(ctx);
    const client = createInstallationClient({
      installationId: INSTALLATION_ID,
      apiBase: API_BASE,
      tokens: ctx.provider,
      fetchImpl: ctx.fake.fetchImpl,
    });
    const failure = await client.getStore().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueekApiError);
    expect((failure as QueekApiError).status).toBe(401);
    expect(mintAttempts(ctx)).toBe(2);
    expect(ctx.fake.merchantCalls).toHaveLength(2);
  });
});

describe("installation client merchant refusals (rev 7: re-mint only on token refusals)", () => {
  function clientFor(ctx: Setup) {
    return createInstallationClient({
      installationId: INSTALLATION_ID,
      apiBase: API_BASE,
      tokens: ctx.provider,
      fetchImpl: ctx.fake.fetchImpl,
    });
  }

  it("403 insufficient_scope: drops the stale-grant token, re-mints once, retries with the fresh token", async () => {
    const ctx = setup({
      merchantQueue: [{ status: 403, code: "insufficient_scope", message: "No scope." }],
    });
    // Cached-valid, so the call needs no mint up front — the stale grant
    // burns exactly one re-mint on the 403, then the retry succeeds.
    seed(ctx, { token: "tok_old_scope", tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await expect(clientFor(ctx).getStore()).resolves.toMatchObject({ data: { p_id: "store_xyz" } });
    expect(mintAttempts(ctx)).toBe(1);
    expect(ctx.fake.merchantCalls).toHaveLength(2);
    const [first, second] = ctx.fake.merchantCalls;
    expect(first?.clientKey).toBe("tok_old_scope");
    expect(second?.clientKey).toBe(ctx.fake.mintCalls[0]?.token);
    expect((await ctx.store.getInstallation(INSTALLATION_ID))?.token).toBe(ctx.fake.mintCalls[0]?.token);
  });

  it("403 insufficient_scope twice: retries once, then the second refusal propagates (never loops)", async () => {
    const ctx = setup({
      merchantQueue: [
        { status: 403, code: "insufficient_scope", message: "No scope." },
        { status: 403, code: "insufficient_scope", message: "Still no scope." },
      ],
    });
    seed(ctx, { token: "tok_old_scope", tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const failure = await clientFor(ctx)
      .getStore()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueekApiError);
    expect((failure as QueekApiError).code).toBe("insufficient_scope");
    // Exactly one re-mint and one retry: the second 403 propagates instead
    // of triggering another drop + mint.
    expect(mintAttempts(ctx)).toBe(1);
    expect(ctx.fake.merchantCalls).toHaveLength(2);
  });

  it("POST with body on 403 insufficient_scope: re-sends the same body under the same Idempotency-Key", async () => {
    const ctx = setup({
      merchantQueue: [{ status: 403, code: "insufficient_scope", message: "No scope." }],
    });
    seed(ctx, { token: "tok_old_scope", tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const body = { definition: "app_test_orders", values: { total: "42.00" } };
    const response = await clientFor(ctx).request<{ data: unknown }>("POST", "/records", { body });
    expect(response).toEqual({ data: {} });
    expect(mintAttempts(ctx)).toBe(1);
    expect(ctx.fake.merchantCalls).toHaveLength(2);
    const [first, second] = ctx.fake.merchantCalls;
    // Same body re-sent intact on the retry …
    expect(first?.body).toBe(JSON.stringify(body));
    expect(second?.body).toBe(JSON.stringify(body));
    // … under the same Idempotency-Key (one key for both attempts, so the
    // retry can never execute twice).
    expect(first?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(second?.clientKey).toBe(ctx.fake.mintCalls[0]?.token);
  });

  it("concurrent double 403 insufficient_scope: at most one extra mint and no loop", async () => {
    const ctx = setup({
      merchantQueue: [
        { status: 403, code: "insufficient_scope", message: "No scope." },
        { status: 403, code: "insufficient_scope", message: "No scope." },
      ],
    });
    seed(ctx, { token: "tok_old_scope", tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const client = clientFor(ctx);
    const [first, second] = await Promise.all([client.getStore(), client.getStore()]);
    expect(first).toMatchObject({ data: { p_id: "store_xyz" } });
    expect(second).toMatchObject({ data: { p_id: "store_xyz" } });
    // Two first attempts (both 403) + two retries on the re-minted token.
    expect(ctx.fake.merchantCalls).toHaveLength(4);
    // Compare-and-clear plus single-flight minting bound the recovery to
    // one extra mint: the loser's late drop is a no-op and it reuses the
    // winner's fresh token instead of minting again.
    expect(mintAttempts(ctx)).toBe(1);
  });

  it("403 api_key_revoked: drops the token, re-mints once, retries with the fresh token", async () => {
    const ctx = setup({
      merchantQueue: [{ status: 403, code: API_KEY_REVOKED_CODE, message: "Revoked." }],
    });
    seed(ctx, { token: "tok_dead", tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await expect(clientFor(ctx).getStore()).resolves.toMatchObject({ data: { p_id: "store_xyz" } });
    expect(mintAttempts(ctx)).toBe(1);
    expect(ctx.fake.merchantCalls).toHaveLength(2);
    const [first, second] = ctx.fake.merchantCalls;
    expect(first?.clientKey).toBe("tok_dead");
    expect(second?.clientKey).toBe(ctx.fake.mintCalls[0]?.token);
  });

  it("403 api_key_revoked then mint 404: the installation is purged", async () => {
    const ctx = setup({
      merchantQueue: [{ status: 403, code: API_KEY_REVOKED_CODE, message: "Revoked." }],
      mintQueue: [{ status: 404, code: "app_installation_gone", message: "Gone." }],
    });
    seed(ctx, { token: "tok_dead", tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const failure = await clientFor(ctx)
      .getStore()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueekApiError);
    expect((failure as QueekApiError).code).toBe("app_installation_gone");
    expect(await ctx.store.getInstallation(INSTALLATION_ID)).toBeNull();
  });

  it("403 app_token_revoked on merchant: drops ALL cached tokens and halts, no mint", async () => {
    const ctx = setup({
      merchantQueue: [{ status: 403, code: APP_TOKEN_REVOKED_CODE, message: "Epoch revoked." }],
    });
    const otherId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const fresh = new Date(Date.now() + 3_600_000).toISOString();
    seed(ctx, { token: "tok_a", tokenExpiresAt: fresh });
    seed(ctx, {
      installationId: otherId,
      installationPid: "inst_other",
      token: "tok_b",
      tokenExpiresAt: fresh,
    });
    const failure = await clientFor(ctx)
      .getStore()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueekApiError);
    expect((failure as QueekApiError).code).toBe(APP_TOKEN_REVOKED_CODE);
    // No mint round-trip: halt is immediate on the merchant signal.
    expect(mintAttempts(ctx)).toBe(0);
    expect((await ctx.store.getInstallation(INSTALLATION_ID))?.token).toBeNull();
    expect((await ctx.store.getInstallation(otherId))?.token).toBeNull();
    expect(ctx.provider.isHalted()).toBe(true);
    for (const line of ctx.lines) expect(jwtShaped(line)).toBe(false);
  });

  it("kid-removal flow: merchant 403 api_key_revoked, re-mint under the current kid succeeds", async () => {
    const ctx = setup({
      merchantQueue: [{ status: 403, code: API_KEY_REVOKED_CODE, message: "Kid removed." }],
    });
    // The cached token was minted under a kid Queek has since removed.
    seed(ctx, {
      token: "tok_old_kid",
      tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      tokenKid: "kid-removed",
    });
    await expect(clientFor(ctx).getStore()).resolves.toMatchObject({ data: { p_id: "store_xyz" } });
    expect(mintAttempts(ctx)).toBe(1);
    // The re-mint rode the app's CURRENT kid (header verified by the fake).
    expect(ctx.fake.mintCalls[0]?.kid).toBe("test-kid-1");
    const row = await ctx.store.getInstallation(INSTALLATION_ID);
    expect(row?.token).toBe(ctx.fake.mintCalls[0]?.token);
    expect(row?.tokenKid).toBe("test-kid-1");
  });
});

describe("grant change drops the cached token so the next call re-mints", () => {
  function clientFor(ctx: Setup) {
    return createInstallationClient({
      installationId: INSTALLATION_ID,
      apiBase: API_BASE,
      tokens: ctx.provider,
      fetchImpl: ctx.fake.fetchImpl,
    });
  }

  it("old-scope token cached, grant adds merchant-items-detail, next call uses a new token", async () => {
    const ctx = setup();
    seed(ctx, {
      scopes: ["merchant-business_profile-read"],
      token: "tok_old_scope",
      tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      tokenKid: "kid-1",
    });
    // The dev loop re-granted with a new scope: the resync merge drops the
    // old-scope token.
    const existing = await ctx.store.getInstallation(INSTALLATION_ID);
    if (!existing) throw new Error("expected a seeded row");
    const data = {
      installation: { id: INSTALLATION_ID, p_id: "inst_abc123" },
      store: { id: "store-id", p_id: "store_xyz", name: "Test Store", is_test: true },
      api_base: API_BASE,
      scopes: ["merchant-business_profile-read", "merchant-items-detail"],
      settings: {},
      webhook_secret: null,
      proxy_secret: null,
      webhook_url: null,
      webhook_topics: [],
    } as InstallData;
    await ctx.store.saveInstallation(saveResyncedInstallation(existing, data));
    expect((await ctx.store.getInstallation(INSTALLATION_ID))?.token).toBeNull();

    // The next call mints fresh (one mint) and succeeds.
    await expect(clientFor(ctx).getStore()).resolves.toMatchObject({ data: { p_id: "store_xyz" } });
    expect(mintAttempts(ctx)).toBe(1);
    expect(ctx.fake.merchantCalls).toHaveLength(1);
    expect(ctx.fake.merchantCalls[0]?.clientKey).toBe(ctx.fake.mintCalls[0]?.token);
  });

  it("a drop for a superseded token value is a no-op: the fresh token survives", async () => {
    const ctx = setup();
    seed(ctx, {
      token: "tok_fresh",
      tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      tokenKid: "kid-1",
    });
    // A late drop carrying the old (superseded) value must not wipe the
    // fresh token a concurrent re-mint just stored.
    await ctx.provider.dropCachedToken(INSTALLATION_ID, "tok_old_scope");
    await expect(ctx.provider.acquireToken(INSTALLATION_ID)).resolves.toBe("tok_fresh");
    expect(mintAttempts(ctx)).toBe(0);
    // A drop carrying the current value still clears.
    await ctx.provider.dropCachedToken(INSTALLATION_ID, "tok_fresh");
    expect((await ctx.store.getInstallation(INSTALLATION_ID))?.token).toBeNull();
  });
});

describe("custom stores without clearCachedTokenIfMatches", () => {
  /** Minimal legacy store: get + clear only, no native compare-and-clear. */
  function legacyStore(initialToken: string | null): {
    store: InstallationStore;
    token: () => string | null;
  } {
    let current = initialToken;
    const stub = {
      getInstallation: () =>
        current === null && initialToken === null
          ? null
          : installationRecord({
              token: current,
              tokenExpiresAt: current === null ? null : new Date(Date.now() + 3_600_000).toISOString(),
              tokenKid: current === null ? null : "kid-1",
            }),
      clearCachedToken: () => {
        current = null;
      },
    };
    return { store: stub as unknown as InstallationStore, token: () => current };
  }

  it("default helper clears only on a match; mismatch and missing rows are no-ops", async () => {
    const { store } = legacyStore("tok_kept");
    expect(await defaultClearCachedTokenIfMatches(store, INSTALLATION_ID, "tok_other")).toBe(false);
    expect(await store.getInstallation(INSTALLATION_ID)).toMatchObject({ token: "tok_kept" });
    expect(await defaultClearCachedTokenIfMatches(store, INSTALLATION_ID, "tok_kept")).toBe(true);
    expect(await store.getInstallation(INSTALLATION_ID)).toMatchObject({ token: null });

    const cleared: string[] = [];
    const missing = {
      getInstallation: () => null,
      clearCachedToken: (id: string) => {
        cleared.push(id);
      },
    } as unknown as InstallationStore;
    expect(await defaultClearCachedTokenIfMatches(missing, INSTALLATION_ID, "tok_x")).toBe(false);
    expect(cleared).toEqual([]);
  });

  it("provider falls back to get+compare+clear when the native method is absent", async () => {
    const keypair = KEYPAIR;
    const fake = fakeQueekAppApi({ keypair });
    const { store, token } = legacyStore("tok_fresh");
    const provider = new AppTokenProvider({
      credential: loadAppCredential({
        appSlug: keypair.slug,
        keyId: keypair.kid,
        privateKeyPem: keypair.privateKeyPem,
      }),
      store,
      fetchImpl: fake.fetchImpl,
      logger: createLogger({ service: "test", sink: () => undefined }),
      sleep: async () => undefined,
      random: () => 0,
    });
    expect("clearCachedTokenIfMatches" in store).toBe(false);
    await provider.dropCachedToken(INSTALLATION_ID, "tok_old_scope");
    expect(token()).toBe("tok_fresh");
    await provider.dropCachedToken(INSTALLATION_ID, "tok_fresh");
    expect(token()).toBeNull();
  });
});

describe("resolveAppApiBase", () => {
  it("maps the handoff base to /api/v1/apps and validates like the merchant client", () => {
    expect(resolveAppApiBase("https://api.usequeek.com")).toBe("https://api.usequeek.com/api/v1/apps");
    expect(resolveAppApiBase("https://api.usequeek.com/api/v1/merchant")).toBe(
      "https://api.usequeek.com/api/v1/apps",
    );
    expect(() => resolveAppApiBase("http://api.usequeek.com")).toThrow();
    expect(() => resolveAppApiBase("https://evil.example.com")).toThrow();
  });
});
