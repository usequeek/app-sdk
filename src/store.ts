import { DatabaseSync } from "node:sqlite";
import { decryptSecret, encryptSecret, parseStoreKey } from "./crypto.js";

/**
 * The app database holds INSTALLATIONS ONLY (decision
 * 2026-09-23-queek-apps-separate-ts-hono-codebase-public-surface-only).
 * Business data lives in Queek (product metafields,
 * orders.integrator_metadata) — never here.
 *
 * `api_key`, `webhook_secret` AND the whole `settings` blob are encrypted
 * at rest (AES-256-GCM via node:crypto, key from `APP_ENCRYPTION_KEY`):
 * manifests may declare `secret` settings (API keys, webhook secrets) and
 * the backend encrypts those too, so the SDK must not be weaker. NOTHING
 * secret is ever logged: only ids and the store p_id may appear in logs.
 */

export interface InstallationRecord {
  /** Queek installation id (string form of the backend UUID). */
  installationId: string;
  /** Queek installation p_id (short public id, safe to log). */
  installationPid: string;
  /** Vendor id (backend UUID, string form). */
  vendorId: string;
  /** Store p_id (safe to log). */
  storePid: string | null;
  /** Store name (safe to log). */
  storeName: string;
  /** Merchant API base handed over at install. */
  apiBase: string;
  /** Plaintext installation credential — memory only, never persisted raw. */
  apiKey: string;
  scopes: string[];
  settings: Record<string, unknown>;
  /** Plaintext per-installation webhook secret — memory only. */
  webhookSecret: string | null;
  webhookUrl: string | null;
  webhookTopics: string[];
  installedAt: string;
  updatedAt: string;
}

export interface WebhookSecretCandidate {
  installationId: string;
  secret: string;
}

export interface InstallationStore {
  saveInstallation(record: InstallationRecord): Promise<void> | void;
  getInstallation(installationId: string): Promise<InstallationRecord | null> | InstallationRecord | null;
  deleteInstallation(installationId: string): Promise<void> | void;
  /** Secrets only (no api keys) for webhook sender identification. */
  listWebhookSecrets(): Promise<WebhookSecretCandidate[]> | WebhookSecretCandidate[];
  /** Replay guard: true when this webhook-id was already processed. */
  hasSeenWebhookId(webhookId: string): Promise<boolean> | boolean;
  /** Record a processed webhook-id (entries expire after 24h). */
  markWebhookSeen(webhookId: string): Promise<void> | void;
  /**
   * Atomically claim a webhook-id: records it and returns true only if no
   * unexpired claim exists. Handlers claim BEFORE running the callback so
   * two concurrent same-id deliveries cannot both execute; on callback
   * failure they `releaseWebhookId` so a Queek retry can still land.
   */
  claimWebhookId(webhookId: string): Promise<boolean> | boolean;
  /** Release a claim (callback failed; a retry may re-run). */
  releaseWebhookId(webhookId: string): Promise<void> | void;
}

export interface SqliteStoreOptions {
  /** Path to the sqlite file. Use `:memory:` for tests. */
  path: string;
  /** Raw `APP_ENCRYPTION_KEY` value (base64 or hex of 32 bytes). */
  storeKey: string;
}

const SEEN_TTL_SECONDS = 24 * 60 * 60;

/**
 * Default `InstallationStore`: SQLite through the Node 22 built-in
 * `node:sqlite` (`DatabaseSync` — synchronous, file-backed, WAL mode).
 *
 * Why not better-sqlite3: its prebuilt binary segfaults on the project's
 * Node 22.12 runtime (observed, not theorised), and building from source
 * would force a C++ toolchain into every environment — dev Macs, CI, and
 * the slim alpine app images. `node:sqlite` is dependency-free with an
 * identical synchronous shape.
 *
 * `node:sqlite` needs no flag since Node 22.13.0 (pinned runtime 22.23.3;
 * an ExperimentalWarning on stderr remains — Stability 1.1). Devs on an
 * older 22 minor set `NODE_OPTIONS=--experimental-sqlite` in their shell.
 * Revisit when the apps run on a Node line where it is fully stable — the
 * swap is contained here, behind `InstallationStore`.
 */
export class SqliteInstallationStore implements InstallationStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;

  constructor(options: SqliteStoreOptions) {
    this.key = parseStoreKey(options.storeKey);
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS installations (
        installation_id TEXT PRIMARY KEY,
        installation_pid TEXT NOT NULL,
        vendor_id TEXT NOT NULL,
        store_pid TEXT,
        store_name TEXT NOT NULL,
        api_base TEXT NOT NULL,
        api_key_enc TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        webhook_secret_enc TEXT,
        webhook_url TEXT,
        webhook_topics_json TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seen_webhook_ids (
        webhook_id TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL
      );
    `);
  }

  saveInstallation(record: InstallationRecord): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO installations (
          installation_id, installation_pid, vendor_id, store_pid, store_name,
          api_base, api_key_enc, scopes_json, settings_json,
          webhook_secret_enc, webhook_url, webhook_topics_json,
          installed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(installation_id) DO UPDATE SET
          installation_pid = excluded.installation_pid,
          vendor_id = excluded.vendor_id,
          store_pid = excluded.store_pid,
          store_name = excluded.store_name,
          api_base = excluded.api_base,
          api_key_enc = excluded.api_key_enc,
          scopes_json = excluded.scopes_json,
          settings_json = excluded.settings_json,
          webhook_secret_enc = excluded.webhook_secret_enc,
          webhook_url = excluded.webhook_url,
          webhook_topics_json = excluded.webhook_topics_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        record.installationId,
        record.installationPid,
        record.vendorId,
        record.storePid,
        record.storeName,
        record.apiBase,
        encryptSecret(record.apiKey, this.key),
        JSON.stringify(record.scopes),
        encryptSecret(JSON.stringify(record.settings), this.key),
        record.webhookSecret === null ? null : encryptSecret(record.webhookSecret, this.key),
        record.webhookUrl,
        JSON.stringify(record.webhookTopics),
        record.installedAt,
        now,
      );
  }

  getInstallation(installationId: string): InstallationRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM installations WHERE installation_id = ?`)
      .get(installationId) as Record<string, string | null> | undefined;
    if (!row) return null;
    return {
      installationId: column(row.installation_id),
      installationPid: column(row.installation_pid),
      vendorId: column(row.vendor_id),
      storePid: (row.store_pid as string | null) ?? null,
      storeName: column(row.store_name),
      apiBase: column(row.api_base),
      apiKey: decryptSecret(column(row.api_key_enc), this.key),
      scopes: JSON.parse(column(row.scopes_json)) as string[],
      settings: JSON.parse(decryptSecret(column(row.settings_json), this.key)) as Record<string, unknown>,
      webhookSecret:
        row.webhook_secret_enc === null ? null : decryptSecret(column(row.webhook_secret_enc), this.key),
      webhookUrl: (row.webhook_url as string | null) ?? null,
      webhookTopics: JSON.parse(column(row.webhook_topics_json)) as string[],
      installedAt: column(row.installed_at),
      updatedAt: column(row.updated_at),
    };
  }

  deleteInstallation(installationId: string): void {
    this.db.prepare(`DELETE FROM installations WHERE installation_id = ?`).run(installationId);
  }

  listWebhookSecrets(): WebhookSecretCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT installation_id, webhook_secret_enc FROM installations WHERE webhook_secret_enc IS NOT NULL`,
      )
      .all() as Array<{ installation_id: string; webhook_secret_enc: string }>;
    return rows.map((row) => ({
      installationId: row.installation_id,
      secret: decryptSecret(row.webhook_secret_enc, this.key),
    }));
  }

  hasSeenWebhookId(webhookId: string): boolean {
    this.pruneSeenIds();
    return (
      this.db.prepare(`SELECT 1 AS one FROM seen_webhook_ids WHERE webhook_id = ?`).get(webhookId) !==
      undefined
    );
  }

  markWebhookSeen(webhookId: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO seen_webhook_ids (webhook_id, seen_at) VALUES (?, ?)`)
      .run(webhookId, Date.now());
  }

  claimWebhookId(webhookId: string): boolean {
    this.pruneSeenIds();
    const result = this.db
      .prepare(`INSERT OR IGNORE INTO seen_webhook_ids (webhook_id, seen_at) VALUES (?, ?)`)
      .run(webhookId, Date.now()) as unknown as { changes: number | bigint };
    return Number(result.changes) === 1;
  }

  releaseWebhookId(webhookId: string): void {
    this.db.prepare(`DELETE FROM seen_webhook_ids WHERE webhook_id = ?`).run(webhookId);
  }

  private pruneSeenIds(): void {
    this.db
      .prepare(`DELETE FROM seen_webhook_ids WHERE seen_at < ?`)
      .run(Date.now() - SEEN_TTL_SECONDS * 1000);
  }

  close(): void {
    this.db.close();
  }
}

function column(value: unknown): string {
  if (typeof value !== "string") throw new Error("Unexpected non-string column in installations table.");
  return value;
}
