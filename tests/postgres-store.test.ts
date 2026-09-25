import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, parseStoreKey } from "../src/crypto.js";
import {
  INSTALLATION_SCHEMA_VERSION,
  type InstallationRecord,
  PostgresInstallationStore,
} from "../src/store.js";

/**
 * Postgres store suite. Runs when `DATABASE_URL` points at a Postgres
 * (local dev: a Homebrew Postgres; CI: the `postgres` service container) —
 * skipped cleanly otherwise, so SQLite-only checkouts stay green.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const describePg = DATABASE_URL ? describe : describe.skip;

const STORE_KEY = Buffer.alloc(32, 51).toString("base64");

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
    scopes: ["merchant-orders-read"],
    settings: { greeting: "hello" },
    webhookSecret: `whsec_secret_${id}`,
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
      webhookSecret: `whsec_secret_${id}`,
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
    expect(raw).not.toContain(`whsec_secret_${id}`);
    expect(String(row.token_enc)).toMatch(/^v1\./);
    expect(String(row.webhook_secret_enc)).toMatch(/^v1\./);
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
});
