import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { decryptSecret, encryptSecret, parseStoreKey } from "./crypto.js";

/**
 * The app database holds INSTALLATIONS ONLY (decision
 * 2026-09-23-queek-apps-separate-ts-hono-codebase-public-surface-only).
 * Business data lives in Queek (product metafields,
 * orders.integrator_metadata) — never here.
 *
 * S1 (SDK 0.2.0): no store-callable credential crosses the install handoff
 * any more, so there is no `api_key` column. The app mints short-lived
 * installation tokens with its asymmetric app key and caches ONE token per
 * installation here (`token_enc` + `token_expires_at` + `token_kid`);
 * `webhook_secret` AND the whole `settings` blob stay encrypted at rest
 * (AES-256-GCM via node:crypto, key from `APP_ENCRYPTION_KEY`): manifests
 * may declare `secret` settings (API keys, webhook secrets) and the backend
 * encrypts those too, so the SDK must not be weaker. NOTHING secret is ever
 * logged: only ids and the store p_id may appear in logs.
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
  /**
   * Cached installation token — plaintext in memory only, persisted as
   * `token_enc`, null when nothing is cached (fresh install, expiry,
   * explicit drop, kill switch). Never logged.
   */
  token: string | null;
  /** ISO-8601 expiry of the cached token, null when none is cached. */
  tokenExpiresAt: string | null;
  /** `kid` the cached token was minted under, null when none is cached. */
  tokenKid: string | null;
  /**
   * True while Queek last answered 409 `app_installation_pending` for this
   * installation (persisted column, survives restarts — the in-process-only
   * mark could not). `GET installations` lists active installations only,
   * so resync's purge-absent step keeps rows flagged here. Cleared when
   * the installation is seen active (resync 202/redelivery) or its mint
   * succeeds; the row's deletion (404 `app_installation_gone`) drops the
   * flag with the row.
   */
  pending: boolean;
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
  /** Every stored installation, ordered by id — resync and cron iterate this. */
  listInstallations(): Promise<InstallationRecord[]> | InstallationRecord[];
  /**
   * Forget one installation's cached token (expiry, token-refusal re-mint,
   * resync) while keeping the installation row: the next `acquireToken`
   * mints fresh.
   */
  clearCachedToken(installationId: string): Promise<void> | void;
  /** Forget EVERY cached token (kill switch) while keeping the rows. */
  clearAllCachedTokens(): Promise<void> | void;
  /**
   * Persist the 409 `app_installation_pending` mark: Queek refused this
   * installation as not-yet-active. The flag survives restarts (plain
   * column, NOT NULL DEFAULT false) so a restart between the 409 and the
   * next resync can never purge the in-flight row the active-only list
   * omits. Idempotent.
   */
  markInstallationPending(installationId: string): Promise<void> | void;
  /**
   * Clear the pending mark: the installation answered active again
   * (resync 202/redelivery) or its mint succeeded.
   */
  clearInstallationPending(installationId: string): Promise<void> | void;
  /** True when the row carries the persisted pending mark (false when the row is missing). */
  isKnownPending(installationId: string): Promise<boolean> | boolean;
  /** Secrets only (no tokens) for webhook sender identification. */
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

const INSTALLATIONS_TABLE_SQLITE = `
      CREATE TABLE IF NOT EXISTS installations (
        installation_id TEXT PRIMARY KEY,
        installation_pid TEXT NOT NULL,
        vendor_id TEXT NOT NULL,
        store_pid TEXT,
        store_name TEXT NOT NULL,
        api_base TEXT NOT NULL,
        token_enc TEXT,
        token_expires_at TEXT,
        token_kid TEXT,
        pending INTEGER NOT NULL DEFAULT 0,
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
`;

/**
 * Default local/dev/test `InstallationStore`: SQLite through the Node 22
 * built-in `node:sqlite` (`DatabaseSync` — synchronous, file-backed, WAL
 * mode).
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
 *
 * 0.1.x → 0.2.0 upgrade: databases created by SDK 0.1.x carry a legacy
 * `api_key_enc` column (the handoff no longer delivers that key, so its
 * value is dead — minted tokens replace it; resync restores connectivity).
 * Opening such a database adds the token-cache columns and drops
 * `api_key_enc`; the legacy ciphertext is discarded, never decrypted.
 */
export class SqliteInstallationStore implements InstallationStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;

  constructor(options: SqliteStoreOptions) {
    this.key = parseStoreKey(options.storeKey);
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(INSTALLATIONS_TABLE_SQLITE);
    this.migrateFromApiKeySchema();
  }

  private migrateFromApiKeySchema(): void {
    const columns = this.db.prepare(`PRAGMA table_info(installations)`).all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (names.has("api_key_enc")) {
      for (const column of ["token_enc", "token_expires_at", "token_kid"] as const) {
        if (!names.has(column)) this.db.exec(`ALTER TABLE installations ADD COLUMN ${column} TEXT;`);
      }
      // The 0.1.x handoff key is superseded by minted installation tokens:
      // its ciphertext is dropped, never decrypted or re-encrypted.
      this.db.exec(`ALTER TABLE installations DROP COLUMN api_key_enc;`);
    }
    // Schema v2 (B2 review r2): the persisted 409-pending mark. Existing
    // rows backfill to 0 (not pending); fresh tables already carry the
    // column via the CREATE above, so this is a no-op for them.
    const live = new Set(
      (this.db.prepare(`PRAGMA table_info(installations)`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!live.has("pending")) {
      this.db.exec(`ALTER TABLE installations ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;`);
    }
  }

  saveInstallation(record: InstallationRecord): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO installations (
          installation_id, installation_pid, vendor_id, store_pid, store_name,
          api_base, token_enc, token_expires_at, token_kid, pending,
          scopes_json, settings_json,
          webhook_secret_enc, webhook_url, webhook_topics_json,
          installed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(installation_id) DO UPDATE SET
          installation_pid = excluded.installation_pid,
          vendor_id = excluded.vendor_id,
          store_pid = excluded.store_pid,
          store_name = excluded.store_name,
          api_base = excluded.api_base,
          token_enc = excluded.token_enc,
          token_expires_at = excluded.token_expires_at,
          token_kid = excluded.token_kid,
          pending = excluded.pending,
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
        record.token === null ? null : encryptSecret(record.token, this.key),
        record.tokenExpiresAt,
        record.tokenKid,
        record.pending ? 1 : 0,
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
    return rowToRecord(row, this.key);
  }

  listInstallations(): InstallationRecord[] {
    const rows = this.db.prepare(`SELECT * FROM installations ORDER BY installation_id`).all() as Array<
      Record<string, string | null>
    >;
    return rows.map((row) => rowToRecord(row, this.key));
  }

  clearCachedToken(installationId: string): void {
    this.db
      .prepare(
        `UPDATE installations SET token_enc = NULL, token_expires_at = NULL, token_kid = NULL
         WHERE installation_id = ?`,
      )
      .run(installationId);
  }

  clearAllCachedTokens(): void {
    this.db
      .prepare(`UPDATE installations SET token_enc = NULL, token_expires_at = NULL, token_kid = NULL`)
      .run();
  }

  deleteInstallation(installationId: string): void {
    this.db.prepare(`DELETE FROM installations WHERE installation_id = ?`).run(installationId);
  }

  markInstallationPending(installationId: string): void {
    this.db.prepare(`UPDATE installations SET pending = 1 WHERE installation_id = ?`).run(installationId);
  }

  clearInstallationPending(installationId: string): void {
    this.db.prepare(`UPDATE installations SET pending = 0 WHERE installation_id = ?`).run(installationId);
  }

  isKnownPending(installationId: string): boolean {
    const row = this.db
      .prepare(`SELECT pending FROM installations WHERE installation_id = ?`)
      .get(installationId) as { pending: unknown } | undefined;
    if (!row) return false;
    return toPendingFlag(row.pending);
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

function rowToRecord(row: Record<string, string | null>, key: Buffer): InstallationRecord {
  return {
    installationId: column(row.installation_id),
    installationPid: column(row.installation_pid),
    vendorId: column(row.vendor_id),
    storePid: (row.store_pid as string | null) ?? null,
    storeName: column(row.store_name),
    apiBase: column(row.api_base),
    token: row.token_enc === null ? null : decryptSecret(column(row.token_enc), key),
    tokenExpiresAt: (row.token_expires_at as string | null) ?? null,
    tokenKid: (row.token_kid as string | null) ?? null,
    pending: toPendingFlag(row.pending),
    scopes: JSON.parse(column(row.scopes_json)) as string[],
    settings: JSON.parse(decryptSecret(column(row.settings_json), key)) as Record<string, unknown>,
    webhookSecret:
      row.webhook_secret_enc === null ? null : decryptSecret(column(row.webhook_secret_enc), key),
    webhookUrl: (row.webhook_url as string | null) ?? null,
    webhookTopics: JSON.parse(column(row.webhook_topics_json)) as string[],
    installedAt: column(row.installed_at),
    updatedAt: column(row.updated_at),
  };
}

function column(value: unknown): string {
  if (typeof value !== "string") throw new Error("Unexpected non-string column in installations table.");
  return value;
}

/**
 * Read the persisted pending flag across drivers: SQLite stores
 * `INTEGER 0/1`, Postgres `BOOLEAN`. Anything unrecognised (including
 * NULL on a pre-migration row, which cannot happen — the column is NOT
 * NULL with a default — but belt-and-braces) reads as not pending.
 */
function toPendingFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "t" || value === "true";
}

/**
 * Current schema revision, stored as exactly one row in `schema_version`
 * (Postgres) and enforced by column-presence migration (SQLite).
 * v2 adds the persisted 409-pending mark (`pending`, NOT NULL DEFAULT
 * false on both drivers).
 */
export const INSTALLATION_SCHEMA_VERSION = 2;

export interface PostgresStoreOptions {
  /** Postgres connection string (usually `DATABASE_URL`). */
  connectionString: string;
  /** Raw `APP_ENCRYPTION_KEY` value (base64 or hex of 32 bytes). */
  storeKey: string;
  /** Pool ceiling. Fixed at 2: 2 app replicas × 2 ≤ the per-DB connection cap of 5. */
  poolMax?: number;
}

const SCHEMA_ADVISORY_LOCK = "queek-app-sdk:installations-schema-v1";

/**
 * Production `InstallationStore`: Postgres through `pg` (`Pool`, max 2).
 *
 * Schema safety when two containers boot together: the first statement of
 * `ensureSchema()` takes a Postgres advisory lock, then creates the tables
 * plus exactly one `schema_version` row, then releases the lock — so
 * concurrent boots serialize instead of racing DDL. Every store method
 * awaits the same cached init promise, so no query runs before the schema
 * exists. The AES-256-GCM envelope is byte-identical to the SQLite store
 * (same `encryptSecret`/`decryptSecret`, same `APP_ENCRYPTION_KEY`).
 */
export class PostgresInstallationStore implements InstallationStore {
  private readonly pool: Pool;
  private readonly key: Buffer;
  private readonly ready: Promise<void>;

  constructor(options: PostgresStoreOptions) {
    this.key = parseStoreKey(options.storeKey);
    this.pool = new Pool({ connectionString: options.connectionString, max: options.poolMax ?? 2 });
    this.pool.on("error", () => {
      // Idle-client errors have no request to fail: without this listener
      // they throw as uncaught exceptions. Query errors still reject their
      // own promises. (Deliberately no logging here: the store owns no
      // logger, and logging pool internals would risk leaking the DSN.)
    });
    this.ready = this.ensureSchema();
    // Methods awaiting `ready` surface a connection failure themselves;
    // this preempts an unhandled rejection when Postgres is unreachable at
    // construction (the first call still throws the real error).
    this.ready.catch(() => undefined);
  }

  private async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [SCHEMA_ADVISORY_LOCK]);
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE TABLE IF NOT EXISTS installations (
            installation_id TEXT PRIMARY KEY,
            installation_pid TEXT NOT NULL,
            vendor_id TEXT NOT NULL,
            store_pid TEXT,
            store_name TEXT NOT NULL,
            api_base TEXT NOT NULL,
            token_enc TEXT,
            token_expires_at TIMESTAMPTZ,
            token_kid TEXT,
            pending BOOLEAN NOT NULL DEFAULT FALSE,
            scopes_json TEXT NOT NULL,
            settings_json TEXT NOT NULL,
            webhook_secret_enc TEXT,
            webhook_url TEXT,
            webhook_topics_json TEXT NOT NULL,
            installed_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
          );
          CREATE TABLE IF NOT EXISTS seen_webhook_ids (
            webhook_id TEXT PRIMARY KEY,
            seen_at BIGINT NOT NULL
          );
          -- Schema v2 (B2 review r2): the persisted 409-pending mark.
          -- Fresh tables already carry the column; this migrates v1
          -- databases in place (existing rows backfill to FALSE).
          ALTER TABLE installations
          ADD COLUMN IF NOT EXISTS pending BOOLEAN NOT NULL DEFAULT FALSE;
          -- The guard row always converges to exactly one row at the
          -- current version: v1 databases gain the v2 row and lose the v1
          -- row; fresh databases insert it directly.
          INSERT INTO schema_version (version) VALUES (${INSTALLATION_SCHEMA_VERSION})
          ON CONFLICT (version) DO NOTHING;
          DELETE FROM schema_version WHERE version < ${INSTALLATION_SCHEMA_VERSION};
        `);
      } finally {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [SCHEMA_ADVISORY_LOCK]);
      }
    } finally {
      client.release();
    }
  }

  async saveInstallation(record: InstallationRecord): Promise<void> {
    await this.ready;
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO installations (
         installation_id, installation_pid, vendor_id, store_pid, store_name,
         api_base, token_enc, token_expires_at, token_kid, pending,
         scopes_json, settings_json,
         webhook_secret_enc, webhook_url, webhook_topics_json,
         installed_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (installation_id) DO UPDATE SET
         installation_pid = excluded.installation_pid,
         vendor_id = excluded.vendor_id,
         store_pid = excluded.store_pid,
         store_name = excluded.store_name,
         api_base = excluded.api_base,
         token_enc = excluded.token_enc,
         token_expires_at = excluded.token_expires_at,
         token_kid = excluded.token_kid,
         pending = excluded.pending,
         scopes_json = excluded.scopes_json,
         settings_json = excluded.settings_json,
         webhook_secret_enc = excluded.webhook_secret_enc,
         webhook_url = excluded.webhook_url,
         webhook_topics_json = excluded.webhook_topics_json,
         updated_at = excluded.updated_at`,
      [
        record.installationId,
        record.installationPid,
        record.vendorId,
        record.storePid,
        record.storeName,
        record.apiBase,
        record.token === null ? null : encryptSecret(record.token, this.key),
        record.tokenExpiresAt,
        record.tokenKid,
        record.pending,
        JSON.stringify(record.scopes),
        encryptSecret(JSON.stringify(record.settings), this.key),
        record.webhookSecret === null ? null : encryptSecret(record.webhookSecret, this.key),
        record.webhookUrl,
        JSON.stringify(record.webhookTopics),
        record.installedAt,
        now,
      ],
    );
  }

  async getInstallation(installationId: string): Promise<InstallationRecord | null> {
    await this.ready;
    const result = await this.pool.query(`SELECT * FROM installations WHERE installation_id = $1`, [
      installationId,
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return pgRowToRecord(row, this.key);
  }

  async listInstallations(): Promise<InstallationRecord[]> {
    await this.ready;
    const result = await this.pool.query(`SELECT * FROM installations ORDER BY installation_id`);
    return (result.rows as Array<Record<string, unknown>>).map((row) => pgRowToRecord(row, this.key));
  }

  async clearCachedToken(installationId: string): Promise<void> {
    await this.ready;
    await this.pool.query(
      `UPDATE installations SET token_enc = NULL, token_expires_at = NULL, token_kid = NULL
       WHERE installation_id = $1`,
      [installationId],
    );
  }

  async clearAllCachedTokens(): Promise<void> {
    await this.ready;
    await this.pool.query(
      `UPDATE installations SET token_enc = NULL, token_expires_at = NULL, token_kid = NULL`,
    );
  }

  async deleteInstallation(installationId: string): Promise<void> {
    await this.ready;
    await this.pool.query(`DELETE FROM installations WHERE installation_id = $1`, [installationId]);
  }

  async markInstallationPending(installationId: string): Promise<void> {
    await this.ready;
    await this.pool.query(`UPDATE installations SET pending = TRUE WHERE installation_id = $1`, [
      installationId,
    ]);
  }

  async clearInstallationPending(installationId: string): Promise<void> {
    await this.ready;
    await this.pool.query(`UPDATE installations SET pending = FALSE WHERE installation_id = $1`, [
      installationId,
    ]);
  }

  async isKnownPending(installationId: string): Promise<boolean> {
    await this.ready;
    const result = await this.pool.query(`SELECT pending FROM installations WHERE installation_id = $1`, [
      installationId,
    ]);
    const row = result.rows[0] as { pending: unknown } | undefined;
    if (!row) return false;
    return toPendingFlag(row.pending);
  }

  async listWebhookSecrets(): Promise<WebhookSecretCandidate[]> {
    await this.ready;
    const result = await this.pool.query(
      `SELECT installation_id, webhook_secret_enc FROM installations WHERE webhook_secret_enc IS NOT NULL`,
    );
    return (result.rows as Array<{ installation_id: string; webhook_secret_enc: string }>).map((row) => ({
      installationId: row.installation_id,
      secret: decryptSecret(row.webhook_secret_enc, this.key),
    }));
  }

  async hasSeenWebhookId(webhookId: string): Promise<boolean> {
    await this.ready;
    await this.pruneSeenIds();
    const result = await this.pool.query(`SELECT 1 AS one FROM seen_webhook_ids WHERE webhook_id = $1`, [
      webhookId,
    ]);
    return result.rowCount !== 0;
  }

  async markWebhookSeen(webhookId: string): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO seen_webhook_ids (webhook_id, seen_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [webhookId, Date.now()],
    );
  }

  async claimWebhookId(webhookId: string): Promise<boolean> {
    await this.ready;
    await this.pruneSeenIds();
    const result = await this.pool.query(
      `INSERT INTO seen_webhook_ids (webhook_id, seen_at) VALUES ($1, $2)
       ON CONFLICT (webhook_id) DO NOTHING RETURNING webhook_id`,
      [webhookId, Date.now()],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async releaseWebhookId(webhookId: string): Promise<void> {
    await this.ready;
    await this.pool.query(`DELETE FROM seen_webhook_ids WHERE webhook_id = $1`, [webhookId]);
  }

  private async pruneSeenIds(): Promise<void> {
    await this.pool.query(`DELETE FROM seen_webhook_ids WHERE seen_at < $1`, [
      Date.now() - SEEN_TTL_SECONDS * 1000,
    ]);
  }

  /** Drain the pool (tests and graceful shutdown). */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

function pgText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Unexpected non-string column ${name}.`);
  return value;
}

function pgRowToRecord(row: Record<string, unknown>, key: Buffer): InstallationRecord {
  const tokenEnc = row.token_enc as string | null;
  const webhookSecretEnc = row.webhook_secret_enc as string | null;
  const expires = row.token_expires_at as Date | string | null;
  return {
    installationId: pgText(row.installation_id, "installation_id"),
    installationPid: pgText(row.installation_pid, "installation_pid"),
    vendorId: pgText(row.vendor_id, "vendor_id"),
    storePid: (row.store_pid as string | null) ?? null,
    storeName: pgText(row.store_name, "store_name"),
    apiBase: pgText(row.api_base, "api_base"),
    token: tokenEnc === null ? null : decryptSecret(tokenEnc, key),
    tokenExpiresAt:
      expires === null
        ? null
        : expires instanceof Date
          ? expires.toISOString()
          : new Date(expires).toISOString(),
    tokenKid: (row.token_kid as string | null) ?? null,
    pending: toPendingFlag(row.pending),
    scopes: JSON.parse(pgText(row.scopes_json, "scopes_json")) as string[],
    settings: JSON.parse(decryptSecret(pgText(row.settings_json, "settings_json"), key)) as Record<
      string,
      unknown
    >,
    webhookSecret: webhookSecretEnc === null ? null : decryptSecret(webhookSecretEnc, key),
    webhookUrl: (row.webhook_url as string | null) ?? null,
    webhookTopics: JSON.parse(pgText(row.webhook_topics_json, "webhook_topics_json")) as string[],
    installedAt: toIso(row.installed_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(pgText(value, "timestamp")).toISOString();
}

export interface InstallationStoreSelector {
  /** Raw `APP_ENCRYPTION_KEY` value (base64 or hex of 32 bytes). */
  storeKey: string;
  /**
   * Postgres connection string. Defaults to `DATABASE_URL`; when set (and
   * non-blank) the Postgres store wins, otherwise SQLite.
   */
  databaseUrl?: string;
  /** SQLite file path. Defaults to `QUEEK_DB_PATH`, else `./data/installations.db`. */
  sqlitePath?: string;
  /** Postgres pool ceiling (default 2). */
  poolMax?: number;
}

/**
 * Pick the installation store: `DATABASE_URL` set → Postgres; otherwise
 * SQLite — which production REFUSES (fail fast with a clear message: a
 * live app must never run on a container-local database).
 */
export function createInstallationStore(options: InstallationStoreSelector): InstallationStore {
  const databaseUrl = (options.databaseUrl ?? process.env.DATABASE_URL ?? "").trim();
  if (databaseUrl !== "") {
    return new PostgresInstallationStore({
      connectionString: databaseUrl,
      storeKey: options.storeKey,
      poolMax: options.poolMax,
    });
  }
  if ((process.env.NODE_ENV ?? "") === "production") {
    throw new Error(
      "Refusing to start on SQLite in production: set DATABASE_URL to the app's Postgres database " +
        "(one database per app; SQLite is local/dev/test only).",
    );
  }
  return new SqliteInstallationStore({
    path: options.sqlitePath ?? process.env.QUEEK_DB_PATH ?? "./data/installations.db",
    storeKey: options.storeKey,
  });
}
