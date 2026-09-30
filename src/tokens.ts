import {
  APP_TOKEN_REVOKED_CODE,
  type AppCredential,
  AppMintHaltedError,
  INVALID_CLIENT_CODE,
  isAppTokenRevoked,
  isInstallationGone,
  isInstallationPending,
  isInsufficientScope,
  isTokenRefusal,
  MAX_MINT_ATTEMPTS,
  MINT_BACKOFF_BASE_MS,
  MINT_BACKOFF_MAX_MS,
  RETRY_JITTER_MAX_MS,
  signAppJwt,
  TOKEN_VALIDITY_SKEW_SECONDS,
  UnknownInstallationError,
} from "./app-auth.js";
import {
  createQueekClient,
  MERCHANT_API_PATH,
  newIdempotencyKey,
  QueekApiError,
  type QueekClient,
  queekApiErrorFromResponse,
  type RequestOptions,
  type RetryOptions,
  resolveApiBase,
} from "./client.js";
import { createLogger, type Logger } from "./logger.js";
import type { InstallationStore } from "./store.js";

/**
 * Installation tokens (S1, SDK 0.2.0): the app holds ONE asymmetric app
 * credential and mints short-lived installation tokens from Queek on
 * demand, cached (encrypted) in its own database to near-expiry.
 *
 * - `acquireToken(installationId)`: cached-valid token (expiry more than 5
 *   minutes away) → else sign an app JWT → `POST access_tokens` → persist
 *   (encrypted, expires_at, kid) → return. Every Queek API call in the
 *   installation client goes through it.
 * - A merchant-API token refusal → drop it, re-mint once, retry once; a
 *   second refusal propagates. Token refusal = any 401, or a 403 with
 *   `api_key_revoked` / `api_key_expired` / `invalid_client_key` (rev 7).
 *   A merchant 403 `insufficient_scope` (stale grant) follows the same
 *   drop + re-mint-once + retry-once path. A merchant 403
 *   `app_token_revoked` is the app-wide kill switch (drop all + halt, no
 *   mint); any other merchant 403 (plan, mode) propagates untouched. (If
 *   the re-mint itself hits `invalid_client` / kill-switch / gone, the
 *   mint path below applies those rules.)
 * - Concurrent callers in one process share ONE in-flight mint per
 *   installation (single-flight). Across containers two mints are harmless
 *   by design: Queek keeps coexisting tokens valid (K=2 slots) and the
 *   last write wins the shared cache row; a residual race self-heals via
 *   re-mint on 401.
 * - Error handling exactly per the wire contract: 401 `invalid_client`
 *   halts minting app-wide (loud log, no retry loop); 403 kill-switch
 *   drops ALL cached tokens and halts; 404 `app_installation_gone` purges
 *   the installation; 409 `app_installation_pending` retries later with
 *   backoff — NEVER purges, NEVER halts (the persisted pending mark keeps
 *   the row through restarts and resync's purge-absent step); 429 honors
 *   `Retry-After` +
 *   jitter with bounded retries; 5xx/network bounded exponential backoff.
 */

/** Path of the app-credential API below the store host. */
export const APP_API_PATH = "/api/v1/apps";

/** Minimal surface the installation client needs (stubs stay one-liners). */
export interface AppTokens {
  acquireToken(installationId: string): Promise<string>;
  /**
   * Forget one installation's cached token. When `expectedToken` (the value
   * the failing call presented) is given, the drop is compare-and-clear: a
   * no-op when the store already holds a different (fresher) token, so a
   * late drop can never wipe a concurrent re-mint.
   */
  dropCachedToken(installationId: string, expectedToken?: string): Promise<void>;
  /**
   * Kill-switch path: forget EVERY cached token for the app and halt
   * minting (loud log inside). Called on a merchant 403 `app_token_revoked`.
   */
  revokeAppAccess(): Promise<void>;
}

export interface TokenProviderOptions {
  credential: AppCredential;
  store: InstallationStore;
  fetchImpl?: typeof fetch;
  /** Sent as User-Agent on app-API calls. Defaults to `queek-app/1.0`. */
  userAgent?: string;
  /** Extra allowed `apiBase` hosts (test/local backends). */
  allowedApiHosts?: string[];
  /** Loud halt/drop logs go here. Defaults to a `queek-app-tokens` logger (stderr on warn+). */
  logger?: Logger;
  /** Injectable clock (ms since epoch). Defaults to `Date.now`. */
  nowMs?: () => number;
  /** Injectable sleep for tests. Defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable uniform [0,1) for jitter. Defaults to `Math.random`. */
  random?: () => number;
}

interface MintSuccess {
  token: string;
  expiresAt: string;
  kid: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validate the handoff `apiBase` (https + allowlist, same rules as the
 * merchant client) and normalize it to the app-API base
 * (`<origin>/api/v1/apps`). Throws `InvalidApiBaseError` before any fetch.
 */
export function resolveAppApiBase(raw: string, allowedApiHosts: string[] = []): string {
  const merchant = resolveApiBase(raw, allowedApiHosts);
  return `${merchant.slice(0, merchant.length - MERCHANT_API_PATH.length)}${APP_API_PATH}`;
}

export function mintPath(installationId: string): string {
  return `/installations/${encodeURIComponent(installationId)}/access_tokens`;
}

export class AppTokenProvider implements AppTokens {
  private readonly credential: AppCredential;
  private readonly store: InstallationStore;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly allowedApiHosts: string[];
  private readonly logger: Logger;
  private readonly nowMs: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly inflight = new Map<string, Promise<string>>();
  private halted: AppMintHaltedError | null = null;

  constructor(options: TokenProviderOptions) {
    this.credential = options.credential;
    this.store = options.store;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? "queek-app/1.0";
    this.allowedApiHosts = options.allowedApiHosts ?? [];
    this.logger = options.logger ?? createLogger({ service: "queek-app-tokens" });
    this.nowMs = options.nowMs ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  /** True while minting is halted app-wide (`invalid_client` or kill switch). */
  isHalted(): boolean {
    return this.halted !== null;
  }

  /**
   * Clear a halt (e.g. the key was fixed / the app re-enabled). A process
   * restart clears it too — the halt is in-process only.
   */
  resumeMinting(): void {
    this.halted = null;
  }

  async acquireToken(installationId: string): Promise<string> {
    const shared = this.inflight.get(installationId);
    if (shared) return shared;
    const attempt = this.acquireUnshared(installationId);
    this.inflight.set(installationId, attempt);
    try {
      return await attempt;
    } finally {
      this.inflight.delete(installationId);
    }
  }

  private async acquireUnshared(installationId: string): Promise<string> {
    const row = await this.store.getInstallation(installationId);
    if (!row) throw new UnknownInstallationError(installationId);
    // Cache serves even while halted: a bad app key (or a kill switch)
    // stops MINTING, but tokens minted before it stay usable on the
    // merchant API until they expire.
    if (row.token !== null && row.tokenExpiresAt !== null && this.isFresh(row.tokenExpiresAt)) {
      return row.token;
    }
    if (this.halted) throw this.halted;
    const minted = await this.mintWithRetry(row.apiBase, installationId, row.installationPid);
    // A successful mint proves the installation is active again: persist
    // the fresh token and clear the pending mark in the same write.
    await this.store.saveInstallation({
      ...row,
      token: minted.token,
      tokenExpiresAt: minted.expiresAt,
      tokenKid: minted.kid,
      pending: false,
      updatedAt: new Date(this.nowMs()).toISOString(),
    });
    return minted.token;
  }

  private isFresh(expiresAtIso: string): boolean {
    const expiresMs = Date.parse(expiresAtIso);
    if (Number.isNaN(expiresMs)) return false;
    return expiresMs - this.nowMs() > TOKEN_VALIDITY_SKEW_SECONDS * 1000;
  }

  async dropCachedToken(installationId: string, expectedToken?: string): Promise<void> {
    if (expectedToken === undefined) {
      await this.store.clearCachedToken(installationId);
      return;
    }
    await this.store.clearCachedTokenIfMatches(installationId, expectedToken);
  }

  /** Kill-switch path (also used by ops): forget every cached token, keep the rows. */
  async dropAllCachedTokens(): Promise<void> {
    await this.store.clearAllCachedTokens();
  }

  /**
   * Persist the 409 `app_installation_pending` mark for this installation
   * (store column — survives restarts, B2 review r2). Resync's purge-absent
   * step keeps marked rows (the list covers active installations only).
   * Called by the mint path and by `resyncFromQueek`; idempotent, and a
   * no-op when the row is already gone.
   */
  async markInstallationPending(installationId: string): Promise<void> {
    await this.store.markInstallationPending(installationId);
  }

  /**
   * Clear the persisted pending mark: the installation answered active
   * again (mint success, resync 202/redelivery).
   */
  async clearInstallationPending(installationId: string): Promise<void> {
    await this.store.clearInstallationPending(installationId);
  }

  /**
   * True when the row carries the persisted pending mark. Consulted by
   * resync's purge-absent step; false when the row is missing.
   */
  async isKnownPending(installationId: string): Promise<boolean> {
    return this.store.isKnownPending(installationId);
  }

  /**
   * Kill-switch path from any surface (mint 403, merchant 403, ops):
   * forget EVERY cached token for the app and halt minting, loudly.
   * Clears on process restart or `resumeMinting()`.
   */
  async revokeAppAccess(): Promise<void> {
    await this.store.clearAllCachedTokens();
    this.halted = new AppMintHaltedError(
      APP_TOKEN_REVOKED_CODE,
      "Queek revoked this app's access (kill switch or disabled app). " +
        "All cached tokens dropped. Re-enable the app, then restart (or resumeMinting).",
    );
    this.logger.error("queek app minting halted: access revoked (kill switch / disabled)", {
      code: APP_TOKEN_REVOKED_CODE,
    });
  }

  /** Sign a fresh app JWT (exposed for the app-API calls in `resync.ts`). */
  signJwt(nowSeconds?: number): string {
    return signAppJwt({ credential: this.credential, nowSeconds });
  }

  /**
   * Map an app-endpoint failure to its contract behavior. ALWAYS throws:
   * the halted error, or the original `QueekApiError` after performing the
   * side effect (drop-all / purge). `installationPid` is log-only.
   */
  async handleAppEndpointError(
    error: QueekApiError,
    installation: { id: string; pid: string },
  ): Promise<never> {
    if (error.status === 401) {
      // The wire contract defines 401 on app endpoints as `invalid_client`
      // (bad/expired JWT, unknown kid): fatal for the app regardless of the
      // exact code string — retry-looping a refused identity is never right.
      this.halted = new AppMintHaltedError(
        INVALID_CLIENT_CODE,
        `Queek refused the app credential (status 401, code ${JSON.stringify(error.code)}). ` +
          `Fix APP_PRIVATE_KEY/APP_KEY_ID or re-register, then restart (or resumeMinting).`,
      );
      this.logger.error("queek app minting halted: invalid_client", {
        installation: installation.pid,
        code: error.code,
      });
      throw this.halted;
    }
    if (error.status === 403 && isAppTokenRevoked(error.code)) {
      await this.revokeAppAccess();
      throw this.halted;
    }
    if (error.status === 404 && isInstallationGone(error.code)) {
      // The row's deletion drops its pending mark with it — a gone
      // installation is never "pending".
      await this.store.deleteInstallation(installation.id);
      this.logger.warn("queek installation gone server-side; purged locally", {
        installation: installation.pid,
      });
    }
    // NOTE: 409 `app_installation_pending` never reaches here as a purge
    // or halt — the mint loop retries it with backoff below, and resync
    // handles it per installation. A pending row is marked, never deleted.
    throw error;
  }

  private async mintWithRetry(
    apiBase: string,
    installationId: string,
    installationPid: string,
  ): Promise<MintSuccess> {
    const appBase = resolveAppApiBase(apiBase, this.allowedApiHosts);
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
      try {
        return await this.mintOnce(appBase, installationId, installationPid);
      } catch (error) {
        lastError = error;
        if (!(error instanceof QueekApiError)) throw error;
        // Contract-mapped failures throw their final error from inside
        // `handleAppEndpointError` (halt/drop/purge already performed).
        if (error.status === 401 || error.status === 404 || error.status === 403) {
          await this.handleAppEndpointError(error, { id: installationId, pid: installationPid });
        }
        if (error.status === 409 && isInstallationPending(error.code)) {
          // Pending installation (rev 8, mark persisted per B2 review
          // r2): retry later with backoff — NEVER purge, NEVER halt. The
          // persisted mark keeps the row through restarts and resync's
          // purge-absent step (the list covers active rows only). After
          // the bounded budget the 409 propagates to the caller, which
          // retries later; the mark clears on mint success (same write)
          // or with the row on 404-gone purge.
          await this.markInstallationPending(installationId);
          this.logger.warn("queek installation pending; mint retry later with backoff", {
            installation: installationPid,
            code: error.code,
          });
          if (attempt === MAX_MINT_ATTEMPTS - 1) throw error;
          const backoff = Math.min(MINT_BACKOFF_MAX_MS, MINT_BACKOFF_BASE_MS * 2 ** attempt);
          await this.sleep(this.jittered(backoff));
          continue;
        }
        if (attempt === MAX_MINT_ATTEMPTS - 1) throw error;
        if (error.status === 429) {
          await this.sleep(this.jittered(error.retryAfterMs ?? MINT_BACKOFF_BASE_MS));
          continue;
        }
        if (error.status >= 500 || error.code === "network_error") {
          const backoff = Math.min(MINT_BACKOFF_MAX_MS, MINT_BACKOFF_BASE_MS * 2 ** attempt);
          await this.sleep(this.jittered(backoff));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  private jittered(baseMs: number): number {
    return baseMs + Math.floor(this.random() * RETRY_JITTER_MAX_MS);
  }

  private async mintOnce(
    appBase: string,
    installationId: string,
    installationPid: string,
  ): Promise<MintSuccess> {
    // Signed per attempt (never reused past its ≤10-min window, never logged).
    const jwt = signAppJwt({ credential: this.credential });
    const url = `${appBase}${mintPath(installationId)}`;
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${jwt}`);
    headers.set("Accept", "application/json");
    headers.set("User-Agent", this.userAgent);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: "POST", headers });
    } catch (cause) {
      throw new QueekApiError({
        status: 0,
        code: "network_error",
        message:
          cause instanceof Error ? `Could not reach Queek: ${cause.message}` : "Could not reach Queek.",
      });
    }
    const text = await response.text();
    const parsed: unknown = text === "" ? null : tryParseJson(text);
    if (!response.ok) {
      throw queekApiErrorFromResponse(response.status, parsed, response.headers);
    }
    if (response.status !== 201) {
      throw new Error(
        `Unexpected mint status ${response.status} for installation ${installationPid} (expected 201).`,
      );
    }
    return parseMintBody(parsed, installationPid, this.credential.keyId);
  }
}

function parseMintBody(body: unknown, installationPid: string, kid: string): MintSuccess {
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const token = typeof record.token === "string" && record.token !== "" ? record.token : null;
  const expiresAt = typeof record.expires_at === "string" ? record.expires_at : null;
  if (token === null || expiresAt === null || Number.isNaN(Date.parse(expiresAt))) {
    throw new Error(
      `Malformed mint response for installation ${installationPid}: expected {token, expires_at}.`,
    );
  }
  return { token, expiresAt, kid };
}

/** Create a provider in one call (thin wrapper over `new AppTokenProvider`). */
export function createAppTokenProvider(options: TokenProviderOptions): AppTokenProvider {
  return new AppTokenProvider(options);
}

export interface InstallationClientOptions {
  installationId: string;
  /** Handoff `api_base` (bare store host or full merchant base). Validated at construction. */
  apiBase: string;
  tokens: AppTokens;
  fetchImpl?: typeof fetch;
  /** Sent as User-Agent. Defaults to `queek-app/1.0`. */
  userAgent?: string;
  /** Extra allowed `apiBase` hosts (test/local backends). */
  allowedApiHosts?: string[];
}

/**
 * A `QueekClient` whose every call goes through `acquireToken()`: the
 * installation token is resolved per request (usually a cache hit — the
 * store IS the cache, one shared row per installation), sent as
 * `X-Client-Key`, and on a merchant-API token refusal (any 401, or 403
 * `api_key_revoked` / `api_key_expired` / `invalid_client_key`) — or a 403
 * `insufficient_scope` after a grant change — it is dropped, re-minted
 * once, and the call retried once; a second refusal propagates to the
 * caller. A merchant 403 `app_token_revoked` drops all cached tokens and
 * halts minting; any other 403 propagates without a mint. 429/network
 * retries (`requestWithRetry`) reuse one idempotency key exactly like the
 * static client.
 */
export function createInstallationClient(options: InstallationClientOptions): QueekClient {
  // Validated here, once, before any fetch — same rules as the static client.
  const probe = resolveApiBase(options.apiBase, options.allowedApiHosts ?? []);
  void probe;
  const fetchImpl = options.fetchImpl ?? fetch;
  const userAgent = options.userAgent ?? "queek-app/1.0";
  const allowedApiHosts = options.allowedApiHosts ?? [];
  let cached: { token: string; client: QueekClient } | null = null;

  async function clientForToken(token: string): Promise<QueekClient> {
    if (!cached || cached.token !== token) {
      cached = {
        token,
        client: createQueekClient({
          apiBase: options.apiBase,
          apiKey: token,
          fetchImpl,
          userAgent,
          allowedApiHosts,
        }),
      };
    }
    return cached.client;
  }

  async function request<T>(method: string, path: string, requestOptions: RequestOptions = {}): Promise<T> {
    const token = await options.tokens.acquireToken(options.installationId);
    // One Idempotency-Key for both attempts (generated here when the caller
    // did not supply one): the inner client would otherwise mint a fresh key
    // per attempt, so the retry would carry a different key. Reads keep no
    // key, exactly like the static client.
    const upper = method.toUpperCase();
    const isWrite = upper === "POST" || upper === "PUT" || upper === "PATCH" || upper === "DELETE";
    const idempotencyKey = requestOptions.idempotencyKey ?? (isWrite ? newIdempotencyKey() : undefined);
    const attemptOptions =
      idempotencyKey === undefined ? requestOptions : { ...requestOptions, idempotencyKey };
    try {
      return await (await clientForToken(token)).request<T>(method, path, attemptOptions);
    } catch (error) {
      if (!(error instanceof QueekApiError)) throw error;
      // Kill switch / disabled app, observed on the merchant path: drop
      // every cached token and halt minting, then propagate this refusal
      // (no mint — the app is revoked, not the token).
      if (error.status === 403 && isAppTokenRevoked(error.code)) {
        await options.tokens.revokeAppAccess();
        throw error;
      }
      // Stale grant: the cached token predates a scope change (e.g. the
      // dev loop re-granted with a new scope). Drop it, re-mint once,
      // retry once — exactly like a dead token. The retry is a direct
      // client call, never a recursive `request()`, so a second 403
      // propagates instead of looping. A scope 403 fails the scope check
      // before executing anything, so re-sending the same body under the
      // same Idempotency-Key cannot duplicate a write.
      if (isInsufficientScope(error.status, error.code)) {
        await options.tokens.dropCachedToken(options.installationId, token);
        const fresh = await options.tokens.acquireToken(options.installationId);
        return (await clientForToken(fresh)).request<T>(method, path, attemptOptions);
      }
      // Token refusals ONLY (rev 7): any 401, or a 403 carrying a
      // revoked/expired-key code. Every other 403 (plan, mode) propagates
      // to the caller without burning a mint.
      if (!isTokenRefusal(error.status, error.code)) throw error;
      // Dead token: drop it, re-mint once, retry once. The re-mint runs
      // the full contract error mapping (halt/purge on
      // invalid_client/kill-switch/gone); a second merchant refusal
      // propagates to the caller.
      await options.tokens.dropCachedToken(options.installationId, token);
      const fresh = await options.tokens.acquireToken(options.installationId);
      return (await clientForToken(fresh)).request<T>(method, path, attemptOptions);
    }
  }

  async function requestWithRetry<T>(
    method: string,
    path: string,
    retryOptions: RequestOptions & RetryOptions = {},
  ): Promise<T> {
    const maxAttempts = Math.max(1, Math.floor(retryOptions.maxAttempts ?? 3));
    const baseDelayMs = retryOptions.baseDelayMs ?? 250;
    const maxDelayMs = retryOptions.maxDelayMs ?? 5000;
    const sleep = retryOptions.sleep ?? defaultSleep;
    const idempotencyKey = retryOptions.idempotencyKey;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await request<T>(method, path, { ...retryOptions, idempotencyKey });
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof QueekApiError && (error.isRateLimited || error.code === "network_error");
        if (!retryable || attempt === maxAttempts - 1) throw error;
        const delay =
          error instanceof QueekApiError && error.isRateLimited && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
        await sleep(delay);
      }
    }
    throw lastError;
  }

  return {
    getStore: (signal?: AbortSignal) => request("GET", "/store", { signal }),
    request,
    requestWithRetry,
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}
