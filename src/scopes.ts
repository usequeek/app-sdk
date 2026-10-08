import { isInstallationGone, UnknownInstallationError } from "./app-auth.js";
import { newIdempotencyKey, QueekApiError, queekApiErrorFromResponse } from "./client.js";
import { isAllowedOpenTarget } from "./frame.js";
import { installationScopesEqual } from "./install-handlers.js";
import type { InstallationStore } from "./store.js";
import { resolveAppApiBase } from "./tokens.js";

/**
 * Optional scopes: query, request and revoke.
 *
 * - `queryScopes`: the cached effective grant split against the app's own
 *   declared-optional list. Store-read only, never a fetch: the app-credential
 *   surface exposes the effective grant but no declared-optional list, so
 *   the split needs the app's manifest knowledge (passed at client
 *   construction). No network, no guessing.
 * - `requestScopes`: builds the dashboard deep link that opens the
 *   merchant's consent screen in the dashboard. The SDK never renders
 *   consent — it hands the app a link shaped like the bridge
 *   `open`/`navigate` targets (dashboard-relative path, or an absolute URL
 *   under a given dashboard origin) for the app to open via `sendOpen` or
 *   redirect to. Opening it requires a dashboard that supports the consent
 *   screen, which honours this link shape.
 * - `revokeScopes`: `POST
 *   /api/v1/apps/installations/{installation}/scopes/revoke` with the app
 *   JWT (same credential as mint/resync — not the installation token).
 *   Body `{scopes[]}` (1–50); an `Idempotency-Key` rides the write for
 *   discipline (generated when the caller does not supply one — the client
 *   write discipline), though the route is naturally idempotent: revoking
 *   a never-granted optional scope is 200 with no change. Required scopes
 *   refuse 422 `app_scope_required` (surfaced as `AppScopeRequiredError`).
 *   On 200 the cached grant is refreshed from the response and the cached
 *   token dropped only when the grant moved (same compare-and-clear as the
 *   scopes_update handler — Queek rewrites live token rows in place, so
 *   the drop is a backstop, not the mechanism).
 *
 * Types here are hand-written: the revoke endpoint and the scopes_update
 * handoff live on the app-credential surface, which the bundled
 * `openapi/merchant.json` snapshot does not cover (types are generated app-side by
 * `queek app codegen`; the merchant spec file is never hand-edited).
 */

/** 422 on the revoke endpoint: required scopes are never revocable (uninstall is the remedy). */
export const APP_SCOPE_REQUIRED_CODE = "app_scope_required";

/** 422 on the approve path: the scope is not declared by the live manifest version. */
export const APP_SCOPE_UNDECLARED_CODE = "app_scope_undeclared";

/** True for a required-scope refusal on the revoke endpoint (422 `app_scope_required`). */
export function isAppScopeRequired(status: number, code: string | undefined): boolean {
  return status === 422 && code === APP_SCOPE_REQUIRED_CODE;
}

/**
 * A required-scope refusal, typed so callers switch on the class (or
 * `code`), never on `message`. Carries the offending scopes when Queek
 * named them.
 */
export class AppScopeRequiredError extends QueekApiError {
  readonly scopes: string[];

  constructor(status: number, message: string, scopes: string[]) {
    super({ status, code: APP_SCOPE_REQUIRED_CODE, message });
    this.name = "AppScopeRequiredError";
    this.scopes = scopes;
  }
}

/** Build an `AppScopeRequiredError` from a parsed 422, tolerantly reading the named scopes. */
export function appScopeRequiredFromError(error: QueekApiError): AppScopeRequiredError {
  return new AppScopeRequiredError(error.status, error.message, readErrorScopes(error.errors));
}

function readErrorScopes(errors: unknown): string[] {
  if (typeof errors !== "object" || errors === null) return [];
  const scopes = (errors as Record<string, unknown>).scopes;
  if (!Array.isArray(scopes)) return [];
  return scopes.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

/** Thrown when a scope list fails client-side validation — before any fetch. */
export class InvalidScopesError extends Error {
  readonly code = "invalid_scopes";

  constructor(message: string) {
    super(message);
    this.name = "InvalidScopesError";
  }
}

/** Bounds of the revoke request (1–50 scopes), mirrored client-side. */
export const MAX_SCOPE_LIST = 50;
export const MAX_SCOPE_LENGTH = 120;

/**
 * Validate + normalise a scope list (trim, drop empties, dedupe keeping
 * first order). Mirrors the revoke endpoint's rules (a required array of
 * 1–50 string items) so a malformed call fails before any fetch.
 */
export function normaliseScopeList(scopes: unknown): string[] {
  if (!Array.isArray(scopes)) {
    throw new InvalidScopesError("Expected a scopes array.");
  }
  const cleaned: string[] = [];
  for (const entry of scopes) {
    if (typeof entry !== "string") {
      throw new InvalidScopesError("Every scope must be a string.");
    }
    const trimmed = entry.trim();
    if (trimmed === "" || cleaned.includes(trimmed)) continue;
    if (trimmed.length > MAX_SCOPE_LENGTH) {
      throw new InvalidScopesError(`Scope ${JSON.stringify(trimmed.slice(0, 40))} exceeds 120 characters.`);
    }
    cleaned.push(trimmed);
  }
  if (cleaned.length === 0) {
    throw new InvalidScopesError("Name at least one scope.");
  }
  if (cleaned.length > MAX_SCOPE_LIST) {
    throw new InvalidScopesError(`Too many scopes (max ${MAX_SCOPE_LIST}).`);
  }
  return cleaned;
}

/** The cached-grant split `queryScopes` returns. */
export interface InstallationScopes {
  /** The cached effective grant (grant ∩ tracked manifest), as stored. */
  granted: string[];
  /** The granted scopes that are app-declared optional (granted ∩ declared list, granted order). */
  optional: string[];
}

/**
 * Split a cached grant against the app's declared-optional list (the app's
 * own manifest knowledge). Pure — no store, no network.
 */
export function splitInstallationScopes(
  granted: string[],
  declaredOptional: string[] = [],
): InstallationScopes {
  const declared = new Set(declaredOptional);
  return {
    granted: [...granted],
    optional: granted.filter((scope) => declared.has(scope)),
  };
}

/** App-API path of the revoke endpoint below the app base (sibling of the mint path). */
export function revokeScopesPath(installationId: string): string {
  return `/installations/${encodeURIComponent(installationId)}/scopes/revoke`;
}

export interface ScopeRequestLinkOptions {
  /** The app's dashboard slug (addresses the consent screen). */
  appSlug: string;
  /** Optional scopes to request (validated + normalised). */
  scopes: string[];
  /**
   * Exact dashboard origin (e.g. from the embed query). When given, the
   * link is absolute under it; otherwise dashboard-relative (the bridge
   * `open` convention — resolves under the dashboard origin).
   */
  dashboardOrigin?: string;
}

/**
 * Build the dashboard deep link that opens the merchant's consent screen
 * in the dashboard. Pure — no store, no network. Shaped like the bridge
 * `open` targets: a dashboard-relative path, or an absolute https URL
 * under `dashboardOrigin` (refused exactly like `sendOpen` refuses a bad
 * target).
 *
 * Link shape (the contract the dashboard's consent screen honours):
 * `/apps?app={slug}&view=scopes&scopes={a},{b}` (each scope
 * URL-encoded, comma-separated). The link carries the slug + the scope
 * list only: the dashboard resolves the installation from the signed-in
 * store.
 */
export function buildScopeRequestLink(options: ScopeRequestLinkOptions): string {
  const slug = options.appSlug.trim();
  if (slug === "" || slug.includes("/") || slug.includes("\\")) {
    throw new InvalidScopesError("A dashboard app slug is required to build the scope-request link.");
  }
  const requested = normaliseScopeList(options.scopes);
  const path = `/apps?app=${encodeURIComponent(slug)}&view=scopes&scopes=${requested.map((scope) => encodeURIComponent(scope)).join(",")}`;
  const origin = options.dashboardOrigin?.trim();
  if (!origin) return path;
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    throw new InvalidScopesError("The dashboard origin is not a valid URL.");
  }
  const link = url.toString();
  if (!isAllowedOpenTarget(link, origin)) {
    throw new InvalidScopesError("The dashboard origin refuses the scope-request link.");
  }
  return link;
}

/** Options for the cached-grant read. */
export interface QueryScopesOptions {
  /** Per-call declared-optional list (wins over the client option). */
  optionalScopes?: string[];
}

/** Options for the scope-request link. */
export interface RequestScopesLinkOptions {
  /** Per-call app slug (wins over the client option). */
  appSlug?: string;
  /** Per-call dashboard origin (wins over the client option). */
  dashboardOrigin?: string;
}

/** Options for the app-initiated revoke. */
export interface RevokeScopesOptions {
  /** Write idempotency (generated when omitted — the client write discipline). */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface InstallationScopesClientOptions {
  /** The installation UUID (addresses the revoke endpoint). */
  installationId: string;
  /** The installation row cache: query reads it, revoke refreshes it. */
  store: InstallationStore;
  /**
   * A fresh app JWT per call — e.g. `() => provider.signJwt()`. The revoke
   * endpoint takes the same app credential as mint/resync (not the
   * installation token).
   */
  signJwt: () => string;
  fetchImpl?: typeof fetch;
  /** Sent as User-Agent. Defaults to `queek-app/1.0`. */
  userAgent?: string;
  /** Extra allowed `apiBase` hosts (test/local API hosts). */
  allowedApiHosts?: string[];
  /** The app's dashboard slug (addresses the scope-request consent screen); per-call override wins. */
  appSlug?: string;
  /**
   * The app's manifest-declared optional scopes — the app's own knowledge
   * (the app-credential surface exposes the effective grant but no
   * declared list). Feeds the `queryScopes` split; per-call override wins.
   */
  optionalScopes?: string[];
  /** Exact dashboard origin for absolute scope-request links; per-call override wins. */
  dashboardOrigin?: string;
}

/**
 * The per-installation scopes session. A sibling of the installation
 * client, not a method on it: the installation client's exact type is part
 * of the public API (and is guarded by a generics type test), so the
 * scopes surface lives here, wired to the same store + token provider.
 *
 * - `queryScopes` reads the cached grant (no network).
 * - `requestScopes` builds the dashboard deep link the merchant approves
 *   at (pure — the SDK never renders consent).
 * - `revokeScopes` calls the app-authenticated revoke endpoint and
 *   refreshes the cache.
 */
export interface InstallationScopesClient {
  queryScopes(options?: QueryScopesOptions): Promise<InstallationScopes>;
  requestScopes(scopes: string[], options?: RequestScopesLinkOptions): string;
  revokeScopes(scopes: string[], options?: RevokeScopesOptions): Promise<string[]>;
}

export function createInstallationScopesClient(
  options: InstallationScopesClientOptions,
): InstallationScopesClient {
  if (!options.installationId || options.installationId.trim() === "") {
    throw new InvalidScopesError("An installation id is required.");
  }
  if (!options.store) {
    throw new InvalidScopesError("An InstallationStore is required.");
  }
  if (typeof options.signJwt !== "function") {
    throw new InvalidScopesError("An app-JWT signer is required (e.g. `() => provider.signJwt()`).");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const userAgent = options.userAgent ?? "queek-app/1.0";
  const allowedApiHosts = options.allowedApiHosts ?? [];

  /**
   * The cached grant split — store-read only, never a fetch. The optional
   * half needs the app's declared-optional list (the app's own manifest
   * knowledge: the app surface exposes the effective grant but no declared
   * list), from the per-call option, the client option, or empty.
   */
  async function queryScopes(queryOptions: QueryScopesOptions = {}): Promise<InstallationScopes> {
    const row = await options.store.getInstallation(options.installationId);
    if (!row) throw new UnknownInstallationError(options.installationId);
    return splitInstallationScopes(row.scopes, queryOptions.optionalScopes ?? options.optionalScopes ?? []);
  }

  /**
   * The dashboard deep link that opens the merchant's consent screen in
   * the dashboard. Pure (no store, no network): the app opens it via
   * `sendOpen` or a redirect and the merchant consents in the dashboard
   * (requires a dashboard that supports the consent screen). Shaped like the bridge `open`
   * targets — dashboard-relative, or absolute under the dashboard origin
   * when one is configured.
   */
  function requestScopes(scopes: string[], linkOptions: RequestScopesLinkOptions = {}): string {
    const appSlug = linkOptions.appSlug ?? options.appSlug;
    if (!appSlug) {
      throw new InvalidScopesError("requestScopes needs the app slug: pass `appSlug` or per-call `appSlug`.");
    }
    return buildScopeRequestLink({
      appSlug,
      scopes,
      dashboardOrigin: linkOptions.dashboardOrigin ?? options.dashboardOrigin,
    });
  }

  /**
   * App-initiated revoke of optional scopes: the app JWT signs the call
   * (same credential as mint/resync), an `Idempotency-Key` rides the write
   * for discipline only (the route is naturally idempotent), and on 200
   * the cached grant is refreshed from the response with the cached token
   * dropped only when the grant moved (same compare-and-clear as the
   * scopes_update handler — a backstop, since Queek rewrites live token
   * rows in place). A required scope refuses 422
   * `app_scope_required` as `AppScopeRequiredError`; a gone installation
   * purges the local row and rethrows; anything else propagates untouched.
   * A 401 never halts here — the mint path owns that mapping and halts on
   * its next call.
   */
  async function revokeScopes(scopes: string[], revokeOptions: RevokeScopesOptions = {}): Promise<string[]> {
    const requested = normaliseScopeList(scopes);
    const row = await options.store.getInstallation(options.installationId);
    if (!row) throw new UnknownInstallationError(options.installationId);
    const appBase = resolveAppApiBase(row.apiBase, allowedApiHosts);
    // Signed per attempt (never reused past its ≤10-min window, never logged).
    const jwt = options.signJwt();
    const url = `${appBase}${revokeScopesPath(options.installationId)}`;
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${jwt}`);
    headers.set("Accept", "application/json");
    headers.set("Content-Type", "application/json");
    headers.set("User-Agent", userAgent);
    headers.set("Idempotency-Key", revokeOptions.idempotencyKey ?? newIdempotencyKey());
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ scopes: requested }),
        signal: revokeOptions.signal,
      });
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
      const error = queekApiErrorFromResponse(response.status, parsed, response.headers);
      if (isAppScopeRequired(error.status, error.code)) throw appScopeRequiredFromError(error);
      if (error.status === 404 && isInstallationGone(error.code)) {
        await options.store.deleteInstallation(options.installationId);
      }
      throw error;
    }
    const updated = parseRevokeBody(parsed);
    // Same compare-and-clear as the scopes_update handler: an unchanged
    // grant (e.g. revoking a never-granted scope — idempotent 200) keeps
    // the cached token, since it still matches the live grant.
    const grantChanged = !installationScopesEqual(row.scopes, updated);
    await options.store.saveInstallation({ ...row, scopes: updated, updatedAt: new Date().toISOString() });
    if (grantChanged) {
      await options.store.clearCachedToken(options.installationId);
    }
    return updated;
  }

  return { queryScopes, requestScopes, revokeScopes };
}

/** Read the 200 revoke response (`{installation: {p_id}, scopes}`) — the refreshed effective grant. */
function parseRevokeBody(body: unknown): string[] {
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const scopes = record.scopes;
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) {
    throw new Error("Malformed revoke response: expected {scopes: string[]}.");
  }
  return [...scopes];
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}
