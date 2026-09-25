import { describe, expect, it } from "vitest";
import {
  APP_TOKEN_REVOKED_CODE,
  AppMintHaltedError,
  INVALID_CLIENT_CODE,
  loadAppCredential,
  UnknownInstallationError,
} from "../src/app-auth.js";
import { createQueekClient, QueekApiError } from "../src/client.js";
import { createLogger } from "../src/logger.js";
import { type InstallationRecord, SqliteInstallationStore } from "../src/store.js";
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
    scopes: [],
    settings: {},
    webhookSecret: null,
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
    // case) sharing one persisted cache row; the backend keeps both minted
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
