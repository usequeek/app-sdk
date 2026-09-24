import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, parseStoreKey, storeKeyFingerprint } from "../src/crypto.js";
import { type InstallationRecord, SqliteInstallationStore } from "../src/store.js";

const KEY_B64 = Buffer.alloc(32, 3).toString("base64");
const KEY_HEX = Buffer.alloc(32, 3).toString("hex");

function record(): InstallationRecord {
  return {
    installationId: "11111111-1111-1111-1111-111111111111",
    installationPid: "inst_abc123",
    vendorId: "22222222-2222-2222-2222-222222222222",
    storePid: "store_xyz",
    storeName: "Test Store",
    apiBase: "https://api.usequeek.com/api/v1/merchant",
    apiKey: "sk_test_supersecret_key_material",
    scopes: ["merchant-orders-read"],
    settings: { greeting: "hello", chowdeck_api_key: "sk_chowdeck_merchant_secret_value" },
    webhookSecret: "whsec_super_secret_webhook_material",
    webhookUrl: "https://hello.apps.usequeek.com/webhooks",
    webhookTopics: ["orders/updated"],
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("at-rest encryption (AES-256-GCM via node:crypto)", () => {
  it("round-trips through encrypt/decrypt", () => {
    const key = parseStoreKey(KEY_B64);
    const envelope = encryptSecret("sk_test_abc", key);
    expect(envelope.startsWith("v1.")).toBe(true);
    expect(decryptSecret(envelope, key)).toBe("sk_test_abc");
  });

  it("accepts base64 or hex keys (same bytes, same ciphertext readability)", () => {
    expect(parseStoreKey(KEY_B64)).toEqual(parseStoreKey(KEY_HEX));
    expect(decryptSecret(encryptSecret("x", parseStoreKey(KEY_HEX)), parseStoreKey(KEY_B64))).toBe("x");
  });

  it("rejects empty and short keys", () => {
    expect(() => parseStoreKey(undefined)).toThrow(/QUEEK_STORE_KEY/);
    expect(() => parseStoreKey("too-short")).toThrow(/32 bytes/);
  });

  it("fails closed on tampered envelopes and wrong keys", () => {
    const key = parseStoreKey(KEY_B64);
    const envelope = encryptSecret("sk_test_abc", key);
    expect(() => decryptSecret(`${envelope}tampered`, key)).toThrow();
    expect(() => decryptSecret(envelope, Buffer.alloc(32, 9))).toThrow();
    expect(() => decryptSecret("not-an-envelope", key)).toThrow();
  });

  it("uses a fresh IV per value (same plaintext, different envelopes)", () => {
    const key = parseStoreKey(KEY_B64);
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key));
  });

  it("the fingerprint is safe to log: it reveals nothing usable", () => {
    const fingerprint = storeKeyFingerprint(parseStoreKey(KEY_B64));
    expect(fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(KEY_B64).not.toContain(fingerprint);
  });
});

describe("SqliteInstallationStore", () => {
  const files: string[] = [];
  afterEach(() => {
    for (const file of files.splice(0)) {
      for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        if (existsSync(`${file}${suffix}`)) rmSync(`${file}${suffix}`);
      }
    }
  });

  it("round-trips an installation, including secrets and settings", () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: KEY_B64 });
    store.saveInstallation(record());
    const loaded = store.getInstallation("11111111-1111-1111-1111-111111111111");
    expect(loaded).toMatchObject({
      installationPid: "inst_abc123",
      apiKey: "sk_test_supersecret_key_material",
      webhookSecret: "whsec_super_secret_webhook_material",
      settings: { greeting: "hello", chowdeck_api_key: "sk_chowdeck_merchant_secret_value" },
    });
    expect(store.getInstallation("missing")).toBeNull();
    store.deleteInstallation("11111111-1111-1111-1111-111111111111");
    expect(store.getInstallation("11111111-1111-1111-1111-111111111111")).toBeNull();
    store.close();
  });

  it("never persists plaintext secrets: the db file holds ciphertext only (settings blob included)", () => {
    const file = join(tmpdir(), `queek-store-test-${Date.now()}.db`);
    files.push(file);
    const store = new SqliteInstallationStore({ path: file, storeKey: KEY_B64 });
    store.saveInstallation(record());
    store.close();

    const raw = readFileSync(file);
    expect(raw.includes(Buffer.from("sk_test_supersecret_key_material"))).toBe(false);
    expect(raw.includes(Buffer.from("whsec_super_secret_webhook_material"))).toBe(false);
    expect(raw.includes(Buffer.from("sk_chowdeck_merchant_secret_value"))).toBe(false);

    const db = new DatabaseSync(file);
    const row = db
      .prepare(`SELECT api_key_enc, webhook_secret_enc, settings_json FROM installations`)
      .get() as {
      api_key_enc: string;
      webhook_secret_enc: string;
      settings_json: string;
    };
    db.close();
    expect(row.api_key_enc.startsWith("v1.")).toBe(true);
    expect(row.webhook_secret_enc.startsWith("v1.")).toBe(true);
    expect(row.settings_json.startsWith("v1.")).toBe(true);
    // …and the ciphertext still decrypts with the right key.
    expect(decryptSecret(row.api_key_enc, parseStoreKey(KEY_B64))).toBe("sk_test_supersecret_key_material");
    expect(
      (JSON.parse(decryptSecret(row.settings_json, parseStoreKey(KEY_B64))) as Record<string, unknown>)
        .chowdeck_api_key,
    ).toBe("sk_chowdeck_merchant_secret_value");
  });

  it("listWebhookSecrets exposes secrets without api keys", () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: KEY_B64 });
    store.saveInstallation(record());
    const candidates = store.listWebhookSecrets();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      installationId: "11111111-1111-1111-1111-111111111111",
      secret: "whsec_super_secret_webhook_material",
    });
    expect("apiKey" in (candidates[0] as object)).toBe(false);
    store.close();
  });

  it("tracks seen webhook ids for replay protection", () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: KEY_B64 });
    expect(store.hasSeenWebhookId("evt-1")).toBe(false);
    store.markWebhookSeen("evt-1");
    expect(store.hasSeenWebhookId("evt-1")).toBe(true);
    store.close();
  });

  it("claims ids atomically: first wins, release re-arms", () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: KEY_B64 });
    expect(store.claimWebhookId("evt-claim")).toBe(true);
    expect(store.claimWebhookId("evt-claim")).toBe(false);
    expect(store.hasSeenWebhookId("evt-claim")).toBe(true);
    store.releaseWebhookId("evt-claim");
    expect(store.hasSeenWebhookId("evt-claim")).toBe(false);
    expect(store.claimWebhookId("evt-claim")).toBe(true);
    // A different id is unaffected.
    expect(store.claimWebhookId("evt-other")).toBe(true);
    store.close();
  });
});
