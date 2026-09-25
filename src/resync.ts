import { isInstallationGone, RETRY_JITTER_MAX_MS } from "./app-auth.js";
import { QueekApiError, queekApiErrorFromResponse } from "./client.js";
import { createLogger, type Logger } from "./logger.js";
import type { InstallationStore } from "./store.js";
import { type AppTokenProvider, resolveAppApiBase } from "./tokens.js";

/**
 * Connectivity recovery (S1, SDK 0.2.0): after a database loss (or an
 * outage that outlasted the webhook retries), re-list the app's
 * installations from Queek and re-handshake each one's secrets.
 *
 * - `GET /api/v1/apps/installations?cursor=` (secret-free refs, cursor
 *   pagination) → for each listed installation `POST …/resync` → 202
 *   `{status: "delivering"}`; the fresh `webhook_secret` + non-secret
 *   settings arrive over the EXISTING signed install channel (same handoff
 *   envelope as install), handled by the install handler — which accepts a
 *   resync for an existing installation idempotently.
 * - Cached tokens are dropped for every installation still listed (a
 *   post-outage token may be revoked server-side; the next call re-mints).
 * - Local rows ABSENT from the list are purged (covers
 *   uninstall-while-down after the notify retries exhaust).
 * - A per-installation 429 is the rotation COOLDOWN (≤1/hour): that
 *   installation is skipped (recorded, no retry loop); a 429 on the LIST
 *   endpoint is honored (`Retry-After` + jitter) with bounded retries.
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
  /** Listed installations skipped on rotation-cooldown 429. */
  cooldownSkipped: string[];
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

  async function throwOnAppError(
    response: Response,
    installationId: string,
    installationPid: string,
  ): Promise<void> {
    const text = await response.text();
    const parsed: unknown = text === "" ? null : tryParseJson(text);
    const error = queekApiErrorFromResponse(response.status, parsed, response.headers);
    // 404-gone purges inside; 401/403-halt throws the halted error. A
    // per-install resync 429 is the rotation cooldown (skip, no retry);
    // list-endpoint 429s are retried by the caller below, never here.
    await options.tokens.handleAppEndpointError(error, { id: installationId, pid: installationPid });
  }

  // -- List (cursor pagination, secret-free) ---------------------------------
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
      await throwOnAppError(response, "", "");
    }
    const page = (await response.json()) as { data?: ResyncListItem[]; next_cursor?: string | null };
    for (const item of page.data ?? []) listed.push(item);
    attempt = 0; // a good page resets the backoff budget for the next page
    cursor = typeof page.next_cursor === "string" && page.next_cursor !== "" ? page.next_cursor : null;
    listDone = cursor === null;
  }

  // -- Resync each, drop cached tokens, purge the absent ----------------------
  const result: ResyncResult = { listed: [], resyncRequested: [], cooldownSkipped: [], purged: [] };
  const listedIds = new Set<string>();
  for (const item of listed) {
    listedIds.add(item.id);
    result.listed.push(item.id);
    const response = await appFetch(`/installations/${encodeURIComponent(item.id)}/resync`, {
      method: "POST",
    });
    if (response.status === 202) {
      result.resyncRequested.push(item.id);
      continue;
    }
    if (response.status === 429) {
      // Rotation cooldown (≤1/hour): skip this installation, no retry loop.
      result.cooldownSkipped.push(item.id);
      logger.warn("queek resync skipped: rotation cooldown", { installation: item.id });
      continue;
    }
    try {
      await throwOnAppError(response, item.id, item.id);
    } catch (error) {
      // Gone server-side: the row is already purged inside — record it
      // and keep going. Anything else (halt et al.) aborts the run.
      if (error instanceof QueekApiError && error.status === 404 && isInstallationGone(error.code)) {
        result.purged.push(item.id);
        continue;
      }
      throw error;
    }
  }

  // Drop cached tokens for everything still listed (a post-outage token
  // may be revoked server-side; the next call re-mints cleanly)…
  for (const id of listedIds) {
    await options.store.clearCachedToken(id);
  }
  // …and purge local rows Queek no longer lists (uninstall-while-down).
  const local = await options.store.listInstallations();
  for (const row of local) {
    if (!listedIds.has(row.installationId)) {
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
