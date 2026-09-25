import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_INSTALLATION_PENDING_CODE,
  AppMintHaltedError,
  loadAppCredential,
  RESYNC_COOLDOWN_CODE,
} from "../src/app-auth.js";
import { QueekApiError } from "../src/client.js";
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
    pending: false,
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
    expect(result).toEqual({
      listed: [ID_A],
      resyncRequested: [ID_A],
      cooldownSkipped: [],
      pendingSkipped: [],
      purged: [],
    });
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

  it("follows opaque keyset cursors without interpreting them", async () => {
    const ctx = context({
      listItems: [{ id: ID_A }, { id: ID_B }, { id: "cccccccc-cccc-cccc-cccc-cccccccccccc" }],
      listPageSize: 1,
    });
    const result = await resyncFromQueek(resyncArgs(ctx));
    expect(result.listed).toHaveLength(3);
    const cursors = ctx.fake.mock.mock.calls
      .filter((call) => String(call[0]).includes("/api/v1/apps/installations") && call[1]?.method === "GET")
      .map((call) => new URL(String(call[0])).searchParams.get("cursor"))
      .filter((cursor): cursor is string => cursor !== null);
    // Two follow-up pages, both keyed by opaque handles — a client that
    // parsed cursors as numeric offsets could never walk this list.
    expect(cursors).toHaveLength(2);
    for (const cursor of cursors) {
      expect(cursor).toMatch(/^keyset_/);
      expect(Number.isNaN(Number(cursor))).toBe(true);
    }
  });

  it("429 resync_cooldown: skip, recorded, no retry loop", async () => {
    const ctx = context({
      listItems: [{ id: ID_A }],
      resyncQueue: [{ status: 429, code: RESYNC_COOLDOWN_CODE, headers: { "Retry-After": "3600" } }],
    });
    const result = await resyncFromQueek(resyncArgs(ctx));
    expect(result.resyncRequested).toEqual([]);
    expect(result.cooldownSkipped).toEqual([ID_A]);
    expect(result.pendingSkipped).toEqual([]);
    // A one-hour cooldown is never slept through: skipped, not retried.
    expect(ctx.sleeps).toEqual([]);
  });

  it("429 too_many_requests on resync: backs off on Retry-After and retries (never a cooldown skip)", async () => {
    const ctx = context({
      listItems: [{ id: ID_A }],
      resyncQueue: [{ status: 429, code: "too_many_requests", headers: { "Retry-After": "1" } }],
    });
    const result = await resyncFromQueek(resyncArgs(ctx));
    expect(result.resyncRequested).toEqual([ID_A]);
    expect(result.cooldownSkipped).toEqual([]);
    expect(result.pendingSkipped).toEqual([]);
    expect(ctx.sleeps).toEqual([1000]);
  });

  it("persistent 429 too_many_requests on resync: bounded retries, then aborts the run", async () => {
    const ctx = context({
      listItems: [{ id: ID_A }],
      resyncQueue: [
        { status: 429, code: "too_many_requests", headers: { "Retry-After": "0" } },
        { status: 429, code: "too_many_requests", headers: { "Retry-After": "0" } },
        { status: 429, code: "too_many_requests", headers: { "Retry-After": "0" } },
        { status: 429, code: "too_many_requests", headers: { "Retry-After": "0" } },
      ],
    });
    const failure = await resyncFromQueek(resyncArgs(ctx)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueekApiError);
    expect((failure as QueekApiError).status).toBe(429);
    // 1 initial + 2 backoff retries, then the throttle aborts the run —
    // pushing on would only deepen a per-app bucket. Never recorded as
    // a cooldown skip.
    expect(ctx.sleeps).toEqual([0, 0]);
  });

  it("409 pending on resync: retries with backoff, then 202 requests delivery", async () => {
    const ctx = context({
      listItems: [{ id: ID_A }],
      resyncQueue: [{ status: 409, code: APP_INSTALLATION_PENDING_CODE, message: "Pending." }],
    });
    ctx.store.saveInstallation(installationRecord(ID_A));
    const result = await resyncFromQueek(resyncArgs(ctx));
    expect(result.resyncRequested).toEqual([ID_A]);
    expect(result.pendingSkipped).toEqual([]);
    expect(result.purged).toEqual([]);
    expect(ctx.sleeps).toEqual([250]);
    // A 202 proves the installation is active again: the pending mark clears.
    expect(await ctx.provider.isKnownPending(ID_A)).toBe(false);
    expect(await ctx.store.getInstallation(ID_A)).not.toBeNull();
  });

  it("persistent 409 pending on resync: skipped + recorded, row kept and marked", async () => {
    const ctx = context({
      listItems: [{ id: ID_A }],
      resyncQueue: [
        { status: 409, code: APP_INSTALLATION_PENDING_CODE, message: "Pending." },
        { status: 409, code: APP_INSTALLATION_PENDING_CODE, message: "Pending." },
        { status: 409, code: APP_INSTALLATION_PENDING_CODE, message: "Pending." },
        { status: 409, code: APP_INSTALLATION_PENDING_CODE, message: "Pending." },
      ],
    });
    ctx.store.saveInstallation(installationRecord(ID_A));
    const result = await resyncFromQueek(resyncArgs(ctx));
    expect(result.resyncRequested).toEqual([]);
    expect(result.cooldownSkipped).toEqual([]);
    expect(result.pendingSkipped).toEqual([ID_A]);
    expect(result.purged).toEqual([]);
    expect(ctx.sleeps).toEqual([250, 500]);
    // NEVER purged on a 409: the row survives, marked pending.
    expect(await ctx.store.getInstallation(ID_A)).not.toBeNull();
    expect(await ctx.provider.isKnownPending(ID_A)).toBe(true);
  });

  it("purge-absent keeps a locally pending row the active-only list omits", async () => {
    // The app learned ID_B is pending from an earlier mint 409 (same
    // provider, so the mark is visible to resync).
    const ctx = context({
      listItems: [],
      mintQueue: [
        { status: 409, code: APP_INSTALLATION_PENDING_CODE, message: "Pending." },
        { status: 409, code: APP_INSTALLATION_PENDING_CODE, message: "Pending." },
        { status: 409, code: APP_INSTALLATION_PENDING_CODE, message: "Pending." },
      ],
    });
    ctx.store.saveInstallation(installationRecord(ID_B));
    await expect(ctx.provider.acquireToken(ID_B)).rejects.toBeInstanceOf(QueekApiError);
    expect(await ctx.provider.isKnownPending(ID_B)).toBe(true);

    // The list covers active installations only: ID_B is absent, but it
    // must NOT be purged — the app knows it is pending.
    const result = await resyncFromQueek(resyncArgs(ctx));
    expect(result.listed).toEqual([]);
    expect(result.purged).toEqual([]);
    expect(await ctx.store.getInstallation(ID_B)).not.toBeNull();
  });

  it("purge-absent still purges rows that are NOT known pending", async () => {
    const ctx = context({ listItems: [] });
    ctx.store.saveInstallation(installationRecord(ID_B));
    expect(await ctx.provider.isKnownPending(ID_B)).toBe(false);
    const result = await resyncFromQueek(resyncArgs(ctx));
    expect(result.purged).toEqual([ID_B]);
    expect(await ctx.store.getInstallation(ID_B)).toBeNull();
  });

  it("404 gone on one resync purges just that installation; the run continues", async () => {
    // The backend re-checks status on resync (B2 review r2): an
    // uninstall landing between authorize and resync 404s here, and the
    // SDK purges that row without aborting the rest of the run.
    const ctx = context({
      listItems: [{ id: ID_A }, { id: ID_B }],
      resyncQueue: [{ status: 404, code: "app_installation_gone", message: "Gone." }],
    });
    ctx.store.saveInstallation(installationRecord(ID_A));
    ctx.store.saveInstallation(installationRecord(ID_B));
    const result = await resyncFromQueek(resyncArgs(ctx));
    expect(result.resyncRequested).toEqual([ID_B]);
    expect(result.purged).toEqual([ID_A]);
    expect(await ctx.store.getInstallation(ID_A)).toBeNull();
    expect(await ctx.store.getInstallation(ID_B)).not.toBeNull();
  });

  it("restart between a mint 409 and resync: the persisted mark keeps the row (file-backed)", async () => {
    const files: string[] = [];
    try {
      const file = join(tmpdir(), `queek-resync-pending-${Date.now()}.db`);
      files.push(file);
      const storeKey = STORE_KEY;

      const store1 = new SqliteInstallationStore({ path: file, storeKey });
      const fake = fakeQueekAppApi({
        keypair: KEYPAIR,
        listItems: [],
        mintQueue: [
          { status: 409, code: APP_INSTALLATION_PENDING_CODE, message: "Pending." },
          { status: 409, code: APP_INSTALLATION_PENDING_CODE, message: "Pending." },
          { status: 409, code: APP_INSTALLATION_PENDING_CODE, message: "Pending." },
        ],
      });
      const lines: string[] = [];
      const logger = createLogger({ service: "test", sink: (line) => lines.push(line) });
      const credential = loadAppCredential({
        appSlug: KEYPAIR.slug,
        keyId: KEYPAIR.kid,
        privateKeyPem: KEYPAIR.privateKeyPem,
      });
      store1.saveInstallation(installationRecord(ID_B));
      const first = new AppTokenProvider({
        credential,
        store: store1,
        fetchImpl: fake.fetchImpl,
        logger,
        sleep: async () => undefined,
        random: () => 0,
      });
      await expect(first.acquireToken(ID_B)).rejects.toBeInstanceOf(QueekApiError);
      store1.close();

      // Restart: brand-new instances on the same file. The active-only
      // list omits the in-flight install, but the persisted mark keeps
      // it out of the purge.
      const store2 = new SqliteInstallationStore({ path: file, storeKey });
      const second = new AppTokenProvider({
        credential,
        store: store2,
        fetchImpl: fake.fetchImpl,
        logger,
        sleep: async () => undefined,
        random: () => 0,
      });
      expect(await second.isKnownPending(ID_B)).toBe(true);
      const result = await resyncFromQueek({
        apiBase: API_BASE,
        tokens: second,
        store: store2,
        fetchImpl: fake.fetchImpl,
        logger,
        sleep: async () => undefined,
        random: () => 0,
      });
      expect(result.listed).toEqual([]);
      expect(result.purged).toEqual([]);
      expect(await store2.getInstallation(ID_B)).not.toBeNull();
      store2.close();
    } finally {
      for (const file of files.splice(0)) {
        for (const suffix of ["", "-journal", "-wal", "-shm"]) {
          if (existsSync(`${file}${suffix}`)) rmSync(`${file}${suffix}`);
        }
      }
    }
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
