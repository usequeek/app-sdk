import {
  isInstallationGone,
  isInstallationPending,
  isResyncCooldown,
  RETRY_JITTER_MAX_MS,
} from "./app-auth.js";
import { QueekApiError, queekApiErrorFromResponse } from "./client.js";
import { createLogger, type Logger } from "./logger.js";
import type { InstallationStore } from "./store.js";
import { type AppTokenProvider, resolveAppApiBase } from "./tokens.js";

/**
 * Connectivity recovery (S1, SDK 0.2.0): after a database loss (or an
 * outage that outlasted the webhook retries), re-list the app's
 * installations from Queek and re-handshake each one's secrets.
 *
 * - `GET /api/v1/apps/installations?cursor=` (secret-free refs for ACTIVE
 *   installations only; the cursor is opaque keyset — followed until null,
 *   never interpreted) → for each listed installation `POST …/resync` →
 *   202 `{status: "delivering"}`; the fresh `webhook_secret` + non-secret
 *   settings arrive over the EXISTING signed install channel (same handoff
 *   envelope as install), handled by the install handler — which accepts a
 *   resync for an existing installation idempotently.
 * - Per-installation refusals (rev 8, distinguished by code): 409
 *   `app_installation_pending` retries later with backoff (bounded, then
 *   skipped + recorded — NEVER purged); 429 `resync_cooldown` is the
 *   rotation COOLDOWN (≤1/hour: skipped + recorded, no retry loop); any
 *   OTHER 429 is the per-app bucket (`too_many_requests`: `Retry-After` +
 *   jitter, bounded retries — never recorded as a cooldown skip).
 * - Cached tokens are dropped for every installation still listed (a
 *   post-outage token may be revoked server-side; the next call re-mints).
 * - Local rows ABSENT from the list are purged (covers
 *   uninstall-while-down after the notify retries exhaust) — EXCEPT rows
 *   carrying the persisted pending mark (store column, survives restarts):
 *   the list covers active installations only, so absence never purges a
 *   pending row.
 * - A 429 on the LIST endpoint is honored (`Retry-After` + jitter) with
 *   bounded retries.
 *
 * SCOPE: connectivity only (install validity + webhooks + tokens recover
 * with zero merchant action). App WORKING data (inbound tokens, order
 * links, form tokens, app-side-only settings) does NOT come back — it
 * needs the pg_dump backup (RPO ≤ 24 h) plus the `APP_ENCRYPTION_KEY`
 * backup. Events missed beyond Queek's webhook retries (~4 h) are gone;
 * resync cannot backfill them.
 */

export interface ResyncOptions {
  /** The app's Queek backend hosting `/api/v1/apps` (normally any installation's `api_base`). */
  apiBase: string;
  tokens: AppTokenProvider;
  store: InstallationStore;
  fetchImpl?: typeof fetch;
  /** Sent as User-Agent. Defaults to `queek-app/1.0`. */
  userAgent?: string;
  /** Extra allowed `apiBase` hosts (test/local backends). */
  allowedApiHosts?: string[];
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface ResyncResult {
  /** Installations Queek listed. */
  listed: string[];
  /** Installations a resync delivery was requested for (202). */
  resyncRequested: string[];
  /** Listed installations skipped on rotation-cooldown 429 (`resync_cooldown`). */
  cooldownSkipped: string[];
  /**
   * Listed installations still pending (409 `app_installation_pending`)
   * after the bounded retry budget: skipped, never purged. The row stays
   * marked pending so later purge-absent steps keep it too.
   */
  pendingSkipped: string[];
  /** Local rows purged (absent from the list, or 404 `app_installation_gone`). */
  purged: string[];
}

export interface ResyncListItem {
  id: string;
  store: { id: string; name: string };
  api_base: string;
  scopes: string[];
  status: string;
}

const MAX_LIST_ATTEMPTS = 3;
const LIST_BACKOFF_BASE_MS = 250;
const LIST_BACKOFF_MAX_MS = 5_000;

/** Per-installation resync attempts before a retryable refusal is skipped or aborts the run. */
const MAX_RESYNC_ATTEMPTS = 3;
const RESYNC_BACKOFF_BASE_MS = 250;
const RESYNC_BACKOFF_MAX_MS = 5_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resyncFromQueek(options: ResyncOptions): Promise<ResyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const userAgent = options.userAgent ?? "queek-app/1.0";
  const logger = options.logger ?? createLogger({ service: "queek-app-resync" });
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const jittered = (baseMs: number): number => baseMs + Math.floor(random() * RETRY_JITTER_MAX_MS);
  const appBase = resolveAppApiBase(options.apiBase, options.allowedApiHosts ?? []);

  async function appFetch(path: string, init: { method: string }): Promise<Response> {
    // Signed per attempt (never reused past its ≤10-min window, never logged).
    const jwt = options.tokens.signJwt();
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${jwt}`);
    headers.set("Accept", "application/json");
    headers.set("User-Agent", userAgent);
    let response: Response;
    try {
      response = await fetchImpl(`${appBase}${path}`, { method: init.method, headers });
    } catch (cause) {
      throw new QueekApiError({
        status: 0,
        code: "network_error",
        message:
          cause instanceof Error ? `Could not reach Queek: ${cause.message}` : "Could not reach Queek.",
      });
    }
    return response;
  }

  /** Parse an app-endpoint failure without acting on it: the caller below
   *  decides by status + code (pending/cooldown/throttle/gone/halt). */
  async function readAppError(response: Response): Promise<QueekApiError> {
    const text = await response.text();
    const parsed: unknown = text === "" ? null : tryParseJson(text);
    return queekApiErrorFromResponse(response.status, parsed, response.headers);
  }

  // -- List (opaque keyset cursor, secret-free) ------------------------------
  // The cursor is never interpreted — echoed back verbatim until
  // `next_cursor` is null (rev 8: keyset on a stable unique key, scoped to
  // the calling app; inserts/uninstalls mid-walk never skip or duplicate).
  const listed: ResyncListItem[] = [];
  let cursor: string | null = null;
  let attempt = 0;
  let listDone = false;
  while (!listDone) {
    const path = cursor === null ? `/installations` : `/installations?cursor=${encodeURIComponent(cursor)}`;
    let response: Response;
    try {
      response = await appFetch(path, { method: "GET" });
    } catch (error) {
      if (
        error instanceof QueekApiError &&
        error.code === "network_error" &&
        attempt < MAX_LIST_ATTEMPTS - 1
      ) {
        await sleep(jittered(Math.min(LIST_BACKOFF_MAX_MS, LIST_BACKOFF_BASE_MS * 2 ** attempt)));
        attempt += 1;
        continue;
      }
      throw error;
    }
    if (response.status === 429) {
      if (attempt < MAX_LIST_ATTEMPTS - 1) {
        const retryAfter = queekApiErrorFromResponse(429, null, response.headers).retryAfterMs;
        await sleep(jittered(retryAfter ?? LIST_BACKOFF_BASE_MS));
        attempt += 1;
        continue;
      }
      throw queekApiErrorFromResponse(response.status, null, response.headers);
    }
    if (!response.ok || response.status !== 200) {
      // 401/403 halt inside (invalid_client / kill switch); 404-gone is a
      // no-op against the empty id; anything else propagates.
      await options.tokens.handleAppEndpointError(await readAppError(response), { id: "", pid: "" });
    }
    const page = (await response.json()) as { data?: ResyncListItem[]; next_cursor?: string | null };
    for (const item of page.data ?? []) listed.push(item);
    attempt = 0; // a good page resets the backoff budget for the next page
    cursor = typeof page.next_cursor === "string" && page.next_cursor !== "" ? page.next_cursor : null;
    listDone = cursor === null;
  }

  // -- Resync each, drop cached tokens, purge the absent ----------------------
  const result: ResyncResult = {
    listed: [],
    resyncRequested: [],
    cooldownSkipped: [],
    pendingSkipped: [],
    purged: [],
  };
  const listedIds = new Set<string>();
  for (const item of listed) {
    listedIds.add(item.id);
    result.listed.push(item.id);
    const resyncPath = `/installations/${encodeURIComponent(item.id)}/resync`;
    for (let attempt = 0; ; attempt++) {
      const response = await appFetch(resyncPath, { method: "POST" });
      if (response.status === 202) {
        result.resyncRequested.push(item.id);
        await options.tokens.clearInstallationPending(item.id);
        break;
      }
      const error = await readAppError(response);
      if (response.status === 429 && isResyncCooldown(error.code)) {
        // Rotation cooldown (≤1/hour): skip this installation, no retry loop.
        result.cooldownSkipped.push(item.id);
        logger.warn("queek resync skipped: rotation cooldown", { installation: item.id });
        break;
      }
      if (response.status === 429) {
        // Per-app bucket (rev 8): back off on `Retry-After` (jittered) and
        // retry — never recorded as a cooldown skip. An exhausted budget
        // aborts the run: the whole app is throttled, so pushing on would
        // only deepen it; the caller retries later.
        if (attempt >= MAX_RESYNC_ATTEMPTS - 1) throw error;
        await sleep(jittered(error.retryAfterMs ?? RESYNC_BACKOFF_BASE_MS));
        continue;
      }
      if (response.status === 409 && isInstallationPending(error.code)) {
        // Pending installation (rev 8, mark persisted per B2 review r2):
        // retry later with backoff — NEVER purge. An exhausted budget
        // skips (recorded); the persisted mark survives restarts, so the
        // purge-absent step below (and after a restart) keeps the row.
        await options.tokens.markInstallationPending(item.id);
        if (attempt >= MAX_RESYNC_ATTEMPTS - 1) {
          result.pendingSkipped.push(item.id);
          logger.warn("queek resync skipped: installation pending", { installation: item.id });
          break;
        }
        const backoff = Math.min(RESYNC_BACKOFF_MAX_MS, RESYNC_BACKOFF_BASE_MS * 2 ** attempt);
        await sleep(jittered(backoff));
        continue;
      }
      try {
        // 404-gone purges inside; 401/403-halt throws the halted error; a
        // 409 with any OTHER code rethrows here untouched (never purged).
        await options.tokens.handleAppEndpointError(error, { id: item.id, pid: item.id });
      } catch (endpointError) {
        // Gone server-side: the row is already purged inside — record it
        // and keep going. Anything else (halt et al.) aborts the run.
        if (
          endpointError instanceof QueekApiError &&
          endpointError.status === 404 &&
          isInstallationGone(endpointError.code)
        ) {
          result.purged.push(item.id);
          break;
        }
        throw endpointError;
      }
    }
  }

  // Drop cached tokens for everything still listed (a post-outage token
  // may be revoked server-side; the next call re-mints cleanly)…
  for (const id of listedIds) {
    await options.store.clearCachedToken(id);
  }
  // …and purge local rows Queek no longer lists (uninstall-while-down) —
  // EXCEPT rows carrying the persisted pending mark. The list covers
  // ACTIVE installations only (rev 8), so absence alone never purges a
  // pending row — including after a process restart, because the mark
  // lives in the store column, not in memory. The row stays for a later
  // run, when it is active (listed + resynced), gone (404 → purged), or
  // still pending (kept again).
  const local = await options.store.listInstallations();
  for (const row of local) {
    if (!listedIds.has(row.installationId)) {
      if (await options.tokens.isKnownPending(row.installationId)) {
        logger.warn("queek resync kept a pending installation absent from Queek's list", {
          installation: row.installationPid,
        });
        continue;
      }
      await options.store.deleteInstallation(row.installationId);
      result.purged.push(row.installationId);
      logger.warn("queek resync purged an installation absent from Queek's list", {
        installation: row.installationPid,
      });
    }
  }
  return result;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}
