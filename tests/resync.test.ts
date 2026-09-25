import { describe, expect, it } from "vitest";
import { AppMintHaltedError, loadAppCredential } from "../src/app-auth.js";
import { createInstallHandlers } from "../src/install-handlers.js";
import { createLogger } from "../src/logger.js";
import { resyncFromQueek } from "../src/resync.js";
import { type InstallationRecord, SqliteInstallationStore } from "../src/store.js";
import { AppTokenProvider, createInstallationClient } from "../src/tokens.js";
import { fakeQueekAppApi, testAppKeypair } from "./fake-queek-app-api.js";
import { installBody, postRaw, signedHeaders } from "./helpers.js";

const STORE_KEY = Buffer.alloc(32, 43).toString("base64");
const APP_SECRET = "whsec_YXBwc2lnbmluZ3NlY3JldGFwcHNlY3JldA==";
const API_BASE = "https://api.usequeek.com";
const NOW = 1758685600;
const ID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function installationRecord(id: string, overrides: Partial<InstallationRecord> = {}): InstallationRecord {
  return {
    installationId: id,
    installationPid: `inst_${id.slice(0, 4)}`,
    vendorId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    storePid: "store_xyz",
    storeName: "Test Store",
    apiBase: API_BASE,
    token: null,
    tokenExpiresAt: null,
    tokenKid: null,
    scopes: [],
    settings: {},
    webhookSecret: "whsec_old_secret",
    webhookUrl: null,
    webhookTopics: [],
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// One keypair per file: RSA keygen is slow (the mismatch pair below is
// also module scope, not per test).
const KEYPAIR = testAppKeypair();
const MISMATCH_FAKE_KEYPAIR = testAppKeypair();
const MISMATCH_PROVIDER_KEYPAIR = testAppKeypair("other-app", "other-kid");

function context(
  fakeOptions: Omit<Parameters<typeof fakeQueekAppApi>[0], "keypair"> = {},
  fakeKeypair = KEYPAIR,
  providerKeypair = fakeKeypair,
) {
  const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
  const fake = fakeQueekAppApi({ keypair: fakeKeypair, ...fakeOptions });
  const lines: string[] = [];
  const logger = createLogger({ service: "test", sink: (line) => lines.push(line) });
  const sleeps: number[] = [];
  const provider = new AppTokenProvider({
    credential: loadAppCredential({
      appSlug: providerKeypair.slug,
      keyId: providerKeypair.kid,
      privateKeyPem: providerKeypair.privateKeyPem,
    }),
    store,
    fetchImpl: fake.fetchImpl,
    logger,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    random: () => 0,
  });
  return { store, fake, provider, lines, sleeps, logger, fakeKeypair, providerKeypair };
}

function resyncArgs(ctx: ReturnType<typeof context>) {
  return {
    apiBase: API_BASE,
    tokens: ctx.provider,
    store: ctx.store,
    fetchImpl: ctx.fake.fetchImpl,
    logger: ctx.logger,
    sleep: async (ms: number) => {
      ctx.sleeps.push(ms);
    },
    random: () => 0,
  };
}

/** Simulate Queek's redelivery of the install envelope over the signed handoff channel. */
async function deliverHandoff(
  ctx: ReturnType<typeof context>,
  installationId: string,
  headerId: string,
  webhookSecret: string,
): Promise<void> {
  const app = createInstallHandlers({ appSecret: APP_SECRET, store: ctx.store, nowSeconds: NOW });
  const parsed = JSON.parse(installBody()) as { data: Record<string, unknown> };
  const body = JSON.stringify({
    id: headerId,
    type: "app/installed",
    api_version: "v1",
    created_at: "2026-09-25T00:00:00+00:00",
    data: {
      ...parsed.data,
      installation: { id: installationId, p_id: `inst_${installationId.slice(0, 4)}` },
      api_base: API_BASE,
      webhook_secret: webhookSecret,
    },
  });
  const response = await postRaw(app, "/install", body, signedHeaders(headerId, NOW, body, APP_SECRET));
  expect(response.status).toBe(200);
}

describe("resyncFromQueek", () => {
  it("after wiping the store, restores connectivity end to end (list → resync → handoff → mint → call)", async () => {
    const ctx = context({ listItems: [{ id: ID_A }] });
    // The store is EMPTY (wiped). apiBase is passed explicitly — there is
    // no local row to read it from.
    const result = await resyncFromQueek(resyncArgs(ctx));
    expect(result).toEqual({ listed: [ID_A], resyncRequested: [ID_A], cooldownSkipped: [], purged: [] });
    expect(ctx.fake.resyncCalls).toEqual([ID_A]);

    // The rotated secret arrives over the signed install channel…
    await deliverHandoff(ctx, ID_A, "evt-resync-1", "whsec_fresh_after_wipe");
    const row = await ctx.store.getInstallation(ID_A);
    expect(row?.webhookSecret).toBe("whsec_fresh_after_wipe");

    // …and the installation can call Queek again (connectivity restored).
    const client = createInstallationClient({
      installationId: ID_A,
      apiBase: API_BASE,
      tokens: ctx.provider,
      fetchImpl: ctx.fake.fetchImpl,
    });
    await expect(client.getStore()).resolves.toMatchObject({ data: { p_id: "store_xyz" } });
  });

  it("drops cached tokens for listed installations and purges absent ones", async () => {
    const ctx = context({ listItems: [{ id: ID_A }] });
    ctx.store.saveInstallation(
      installationRecord(ID_A, {
        token: "tok_old",
        tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        tokenKid: "kid-1",
      }),
    );
    ctx.store.saveInstallation(installationRecord(ID_B));

    const result = await resyncFromQueek(resyncArgs(ctx));
    expect(result.listed).toEqual([ID_A]);
    expect(result.purged).toEqual([ID_B]);
    expect(await ctx.store.getInstallation(ID_B)).toBeNull();
    // Still listed: row kept, cached token dropped (next call re-mints).
    expect((await ctx.store.getInstallation(ID_A))?.token).toBeNull();
  });

  it("walks cursor pagination (page size 1, three installations)", async () => {
    const ctx = context({
      listItems: [{ id: ID_A }, { id: ID_B }, { id: "cccccccc-cccc-cccc-cccc-cccccccccccc" }],
      listPageSize: 1,
    });
    const result = await resyncFromQueek(resyncArgs(ctx));
    expect(ctx.fake.listCalls).toBe(3);
    expect(result.listed).toHaveLength(3);
    expect(result.resyncRequested).toHaveLength(3);
  });

  it("treats a per-installation 429 as rotation cooldown: skip, no retry loop", async () => {
    const ctx = context({
      listItems: [{ id: ID_A }],
      resyncQueue: [{ status: 429, code: "too_many_requests", headers: { "Retry-After": "3600" } }],
    });
    const result = await resyncFromQueek(resyncArgs(ctx));
    expect(result.resyncRequested).toEqual([]);
    expect(result.cooldownSkipped).toEqual([ID_A]);
    // A one-hour cooldown is never slept through: skipped, not retried.
    expect(ctx.sleeps).toEqual([]);
  });

  it("purges on 404 app_installation_gone during resync", async () => {
    const ctx = context({
      listItems: [{ id: ID_A }],
      resyncQueue: [{ status: 404, code: "app_installation_gone", message: "Gone." }],
    });
    ctx.store.saveInstallation(installationRecord(ID_A));
    const result = await resyncFromQueek(resyncArgs(ctx));
    expect(result.resyncRequested).toEqual([]);
    expect(result.purged).toEqual([ID_A]);
    expect(await ctx.store.getInstallation(ID_A)).toBeNull();
  });

  it("invalid_client on list halts the app (no resync storm)", async () => {
    // Provider signs with a DIFFERENT key than the fake verifies: every
    // app-API call 401s as invalid_client.
    const ctx = context({ listItems: [{ id: ID_A }] }, MISMATCH_FAKE_KEYPAIR, MISMATCH_PROVIDER_KEYPAIR);
    const failure = await resyncFromQueek(resyncArgs(ctx)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppMintHaltedError);
    expect(ctx.provider.isHalted()).toBe(true);
    expect(ctx.fake.resyncCalls).toEqual([]);
  });
});
