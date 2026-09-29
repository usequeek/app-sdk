import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { APP_INSTALLATION_PENDING_CODE, loadAppCredential } from "../src/app-auth.js";
import { QueekApiError } from "../src/client.js";
import { decryptSecret, parseStoreKey } from "../src/crypto.js";
import { createLogger } from "../src/logger.js";
import { resyncFromQueek } from "../src/resync.js";
import {
  INSTALLATION_SCHEMA_VERSION,
  type InstallationRecord,
  PostgresInstallationStore,
} from "../src/store.js";
import { AppTokenProvider } from "../src/tokens.js";
import { fakeQueekAppApi, testAppKeypair } from "./fake-queek-app-api.js";
import { fakeEmbedSecret, fakeSecret } from "./helpers.js";

/**
 * Postgres store suite. Runs when `DATABASE_URL` points at a Postgres
 * (local dev: a Homebrew Postgres; CI: the `postgres` service container) —
 * skipped cleanly otherwise, so SQLite-only checkouts stay green.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const describePg = DATABASE_URL ? describe : describe.skip;

const STORE_KEY = Buffer.alloc(32, 51).toString("base64");

// One keypair per file: RSA keygen is slow (mirrors tokens/resync tests).
const KEYPAIR = testAppKeypair();

function record(id: string): InstallationRecord {
  return {
    installationId: id,
    installationPid: `inst_${id.slice(0, 4)}`,
    vendorId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    storePid: "store_xyz",
    storeName: "Test Store",
    apiBase: "https://api.usequeek.com/api/v1/merchant",
    token: `tok_secret_${id}`,
    tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    tokenKid: "kid-1",
    pending: false,
    scopes: ["merchant-orders-read"],
    settings: { greeting: "hello" },
    webhookSecret: fakeSecret(`pg-secret-${id}`),
    proxySecret: fakeSecret(`pg-proxy-${id}`),
    embedSecret: fakeEmbedSecret(`pg-embed-${id}`),
    appId: `app-uuid-${id}`,
    webhookUrl: null,
    webhookTopics: [],
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describePg("PostgresInstallationStore", () => {
  const admin = new Pool({ connectionString: DATABASE_URL as string, max: 2 });
  let store: PostgresInstallationStore;

  beforeEach(async () => {
    store = new PostgresInstallationStore({ connectionString: DATABASE_URL as string, storeKey: STORE_KEY });
    // Touch the store first so the advisory-locked schema exists, then
    // truncate for isolation (schema_version survives: it is the guard).
    await store.listInstallations();
    await admin.query(`TRUNCATE installations, seen_webhook_ids`);
  });

  afterAll(async () => {
    await admin.end();
  });

  it("round-trips an installation, including the cached token", async () => {
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    await store.saveInstallation(record(id));
    const loaded = await store.getInstallation(id);
    expect(loaded).toMatchObject({
      installationPid: `inst_${id.slice(0, 4)}`,
      token: `tok_secret_${id}`,
      tokenKid: "kid-1",
      webhookSecret: fakeSecret(`pg-secret-${id}`),
      proxySecret: fakeSecret(`pg-proxy-${id}`),
      settings: { greeting: "hello" },
    });
    expect(loaded?.tokenExpiresAt).toContain("20");
    expect(await store.getInstallation("missing")).toBeNull();
    await store.deleteInstallation(id);
    expect(await store.getInstallation(id)).toBeNull();
    await store.close();
  });

  it("persists ciphertext only (no plaintext token or secret in any raw column)", async () => {
    const id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    await store.saveInstallation(record(id));
    const result = await admin.query(`SELECT * FROM installations WHERE installation_id = $1`, [id]);
    const row = result.rows[0] as Record<string, unknown>;
    const raw = JSON.stringify(row);
    expect(raw).not.toContain(`tok_secret_${id}`);
    expect(raw).not.toContain(fakeSecret(`pg-secret-${id}`));
    expect(raw).not.toContain(fakeSecret(`pg-proxy-${id}`));
    expect(raw).not.toContain(fakeEmbedSecret(`pg-embed-${id}`));
    expect(String(row.embed_secret_enc)).toMatch(/^v1\./);
    expect(row.app_id).toBe(`app-uuid-${id}`);
    expect(String(row.token_enc)).toMatch(/^v1\./);
    expect(String(row.webhook_secret_enc)).toMatch(/^v1\./);
    expect(String(row.proxy_secret_enc)).toMatch(/^v1\./);
    expect(decryptSecret(String(row.token_enc), parseStoreKey(STORE_KEY))).toBe(`tok_secret_${id}`);
    await store.close();
  });

  it("lists, clears one cached token, clears all — rows survive", async () => {
    const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
    for (const id of ids) await store.saveInstallation(record(id));
    expect((await store.listInstallations()).map((row) => row.installationId)).toEqual(ids);

    await store.clearCachedToken(ids[0] as string);
    expect((await store.getInstallation(ids[0] as string))?.token).toBeNull();
    expect((await store.getInstallation(ids[1] as string))?.token).not.toBeNull();

    await store.clearAllCachedTokens();
    expect((await store.getInstallation(ids[1] as string))?.token).toBeNull();
    expect(await store.listInstallations()).toHaveLength(2);
    await store.close();
  });

  it("claims webhook ids atomically with 24h expiry semantics", async () => {
    expect(await store.claimWebhookId("evt-claim")).toBe(true);
    expect(await store.claimWebhookId("evt-claim")).toBe(false);
    expect(await store.hasSeenWebhookId("evt-claim")).toBe(true);
    await store.releaseWebhookId("evt-claim");
    expect(await store.hasSeenWebhookId("evt-claim")).toBe(false);
    await store.close();
  });

  it("two stores ensuring the schema together: one schema_version row, both usable", async () => {
    const second = new PostgresInstallationStore({
      connectionString: DATABASE_URL as string,
      storeKey: STORE_KEY,
    });
    const [left, right] = await Promise.all([store.listInstallations(), second.listInstallations()]);
    expect(left).toEqual([]);
    expect(right).toEqual([]);
    const versions = await admin.query(`SELECT version FROM schema_version`);
    expect(versions.rows).toEqual([{ version: INSTALLATION_SCHEMA_VERSION }]);
    await second.close();
    await store.close();
  });

  it("round-trips the pending flag: save, mark, clear, missing reads false", async () => {
    const id = "33333333-3333-3333-3333-333333333333";
    await store.saveInstallation({ ...record(id), pending: true });
    expect((await store.getInstallation(id))?.pending).toBe(true);
    expect(await store.isKnownPending(id)).toBe(true);
    await store.clearInstallationPending(id);
    expect(await store.isKnownPending(id)).toBe(false);
    expect((await store.getInstallation(id))?.pending).toBe(false);
    await store.markInstallationPending(id);
    expect(await store.isKnownPending(id)).toBe(true);
    expect(await store.isKnownPending("missing")).toBe(false);
    await store.close();
  });

  it("restart through resync: a mint 409 persists the mark, a new instance keeps the row", async () => {
    const id = "44444444-4444-4444-4444-444444444444";
    const fake = fakeQueekAppApi({
      keypair: KEYPAIR,
      listItems: [],
      mintQueue: [
        { status: 409, code: APP_INSTALLATION_PENDING_CODE, message: "Pending." },
        { status: 409, code: APP_INSTALLATION_PENDING_CODE, message: "Pending." },
        { status: 409, code: APP_INSTALLATION_PENDING_CODE, message: "Pending." },
      ],
    });
    const logger = createLogger({ service: "test", sink: () => undefined });
    const credential = loadAppCredential({
      appSlug: KEYPAIR.slug,
      keyId: KEYPAIR.kid,
      privateKeyPem: KEYPAIR.privateKeyPem,
    });
    await store.saveInstallation({ ...record(id), token: null, tokenExpiresAt: null, tokenKid: null });
    const first = new AppTokenProvider({
      credential,
      store,
      fetchImpl: fake.fetchImpl,
      logger,
      sleep: async () => undefined,
      random: () => 0,
    });
    await expect(first.acquireToken(id)).rejects.toBeInstanceOf(QueekApiError);
    expect(await store.isKnownPending(id)).toBe(true);
    await store.close();

    // Restart: brand-new store + provider on the same database. The
    // active-only list omits the in-flight install, but the persisted
    // mark keeps it out of the purge.
    const restarted = new PostgresInstallationStore({
      connectionString: DATABASE_URL as string,
      storeKey: STORE_KEY,
    });
    const second = new AppTokenProvider({
      credential,
      store: restarted,
      fetchImpl: fake.fetchImpl,
      logger,
      sleep: async () => undefined,
      random: () => 0,
    });
    expect(await second.isKnownPending(id)).toBe(true);
    const result = await resyncFromQueek({
      apiBase: "https://api.usequeek.com",
      tokens: second,
      store: restarted,
      fetchImpl: fake.fetchImpl,
      logger,
      sleep: async () => undefined,
      random: () => 0,
    });
    expect(result.listed).toEqual([]);
    expect(result.purged).toEqual([]);
    expect(await restarted.getInstallation(id)).not.toBeNull();
    await restarted.close();
  });

  // Last: it rewrites the shared schema (v1 downgrade) and relies on no
  // later test touching the tables before the migration re-runs below.
  it("migrates a v1 database: adds the column and converges the guard to version 2", async () => {
    const id = "55555555-5555-5555-5555-555555555555";
    await store.saveInstallation(record(id));
    await admin.query(`ALTER TABLE installations DROP COLUMN pending`);
    await admin.query(`DELETE FROM schema_version`);
    await admin.query(`INSERT INTO schema_version (version) VALUES (1)`);

    const migrated = new PostgresInstallationStore({
      connectionString: DATABASE_URL as string,
      storeKey: STORE_KEY,
    });
    // The pre-migration row backfills to not-pending and stays readable.
    expect((await migrated.getInstallation(id))?.pending).toBe(false);
    expect(await migrated.isKnownPending(id)).toBe(false);
    const columns = await admin.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'installations'`,
    );
    expect(columns.rows.map((row) => row.column_name)).toContain("pending");
    const versions = await admin.query(`SELECT version FROM schema_version`);
    expect(versions.rows).toEqual([{ version: INSTALLATION_SCHEMA_VERSION }]);
    expect(INSTALLATION_SCHEMA_VERSION).toBe(4);
    await migrated.close();
    await store.close();
  });
});
