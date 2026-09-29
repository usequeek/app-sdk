import { createHmac, timingSafeEqual } from "node:crypto";
import { type DeliveryResult, toResponse } from "./delivery.js";
import type { InstallationRecord, InstallationStore } from "./store.js";

/**
 * Storefront app-proxy query verification, byte-for-byte compatible with
 * Queek's `App\Services\Apps\AppProxyService` (queek_backend).
 *
 * Queek signs a READ fetch to the app's proxy handler with the installation's
 * `proxy_secret` (`signQuery`): the app verifies server-side before answering
 * the shopper. Canonical signature (Shopify-style, per-install secret):
 *
 *   sig = hex HMAC-SHA256 over
 *     path + "\n" + shop + "\n" + ts + "\n" + sorted(k=v&...) (sig excluded),
 *
 * where each pair is `rawurlencode(key)=rawurlencode(value)` and keys sort
 * byte-wise. The HMAC key is the FULL `whsec_…` string — no base64 decode
 * step (the single most common integration bug cannot happen here).
 *
 * `path` is the QUEEK-side canonical path (`/apps/<subpath>/<rest>`, what
 * the backend signs in `fetch()`), NOT the app's local route: pass it
 * explicitly per route (see `handleProxyRequest`).
 *
 * Layering mirrors the install/webhook handlers: layer 1
 * `verifyProxyDelivery` takes plain data (path + query) and returns a plain
 * result — zero request/response types; layer 2 `handleProxyRequest` adapts
 * the Web standard onto layer 1; `@usequeek/app-sdk/hono`
 * `createProxyHandler` adapts Hono onto layer 2.
 */

export const PROXY_SIGNATURE_PARAM = "sig";
export const PROXY_TIMESTAMP_PARAM = "ts";
export const PROXY_NONCE_PARAM = "jti";
export const PROXY_SHOP_PARAM = "shop";
export const PROXY_CUSTOMER_PARAM = "logged_in_customer_id";
export const PROXY_KID_PARAM = "kid";

/** Backend `apps.proxy_signature_skew_seconds` default; the floor (60s) below applies regardless. */
export const PROXY_MAX_SKEW_SECONDS = 300;

/** Query params as any framework holds them (duplicates collapse to the first value). */
export type ProxyQuery = Record<string, string | string[] | null | undefined>;

/** Failure reason when proxy verification rejects a query. */
export type ProxyFailure =
  | "missing_params"
  | "stale_timestamp"
  | "missing_secret"
  | "signature_mismatch"
  | "unknown_installation"
  | "replayed";

/** PHP `rawurlencode`: everything except `[A-Za-z0-9-_.~]` is `%XX` (upper-case hex). */
function proxyEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => {
    return `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
  });
}

/** PHP `strval` for scalar query values: null/undefined become `""`, everything else stringifies. */
function proxyString(value: string | string[] | null | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "";
  return Array.isArray(value) ? proxyString(value[0]) : String(value);
}

/** Collapse a query to plain strings (duplicates → first value, undefined → absent). */
function normalizeQuery(query: ProxyQuery): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    const flat = proxyString(value);
    if (flat !== undefined) out[key] = flat;
  }
  return out;
}

/**
 * The canonical string the MAC covers — mirrors `AppProxyService::signature()`
 * exactly (sig excluded, keys byte-sorted, rawurlencoded pairs).
 */
export function buildProxyCanonicalString(path: string, params: Record<string, string>): string {
  const sorted = { ...params };
  delete sorted[PROXY_SIGNATURE_PARAM];
  const keys = Object.keys(sorted).sort();
  const pairs = keys.map((key) => `${proxyEncode(key)}=${proxyEncode(sorted[key] as string)}`);
  return `${path}\n${sorted[PROXY_SHOP_PARAM] ?? ""}\n${sorted[PROXY_TIMESTAMP_PARAM] ?? ""}\n${pairs.join("&")}`;
}

/**
 * One hex signature for one secret — mirrors `AppProxyService::signature()`.
 * Exported so tests (and dev harnesses) can recompute a signature
 * independently of the verifier; production traffic is signed by Queek.
 */
export function signProxyQuery(path: string, params: Record<string, string>, secret: string): string {
  return createHmac("sha256", secret).update(buildProxyCanonicalString(path, params), "utf8").digest("hex");
}

export interface ProxyVerifyOptions {
  /** Unix seconds to judge freshness against (defaults to now). Exposed for tests. */
  nowSeconds?: number;
  /** Allowed clock skew in seconds (defaults to PROXY_MAX_SKEW_SECONDS; floored at 60 like the backend). */
  maxSkewSeconds?: number;
}

function readProxyFields(params: Record<string, string>): { sig: string; ts: string; jti: string } {
  return {
    sig: params[PROXY_SIGNATURE_PARAM] ?? "",
    ts: params[PROXY_TIMESTAMP_PARAM] ?? "",
    jti: params[PROXY_NONCE_PARAM] ?? "",
  };
}

function proxySkewExceeded(ts: string, options: ProxyVerifyOptions): boolean {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxSkew = Math.max(60, options.maxSkewSeconds ?? PROXY_MAX_SKEW_SECONDS);
  return Math.abs(now - Number(ts)) > maxSkew;
}

function proxyMacMatches(path: string, params: Record<string, string>, sig: string, secret: string): boolean {
  if (secret === "") return false;
  const expected = signProxyQuery(path, params, secret);
  const expectedBuf = Buffer.from(expected, "utf8");
  const candidateBuf = Buffer.from(sig, "utf8");
  return candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf);
}

/**
 * Pure verification over explicitly passed secrets — mirrors
 * `AppProxyService::verifyQuery()` (structure → skew → secret presence →
 * MAC over every active secret). No replay enforcement here: single-use
 * `jti` needs storage, so the store-backed `verifyProxyDelivery` claims it
 * (the framework-free translation of the backend's atomic `Cache::add`).
 */
export function verifyProxyQueryDetailed(
  path: string,
  query: ProxyQuery,
  secrets: string[],
  options: ProxyVerifyOptions = {},
): { ok: true } | { ok: false; reason: ProxyFailure } {
  const params = normalizeQuery(query);
  const { sig, ts, jti } = readProxyFields(params);
  if (sig === "" || ts === "" || jti === "" || !/^\d+$/.test(ts)) {
    return { ok: false, reason: "missing_params" };
  }
  if (proxySkewExceeded(ts, options)) {
    return { ok: false, reason: "stale_timestamp" };
  }
  if (secrets.length === 0 || secrets[0] === "") {
    return { ok: false, reason: "missing_secret" };
  }
  for (const secret of secrets) {
    if (proxyMacMatches(path, params, sig, secret)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "signature_mismatch" };
}

/** Boolean fast path over {@link verifyProxyQueryDetailed}. */
export function verifyProxyQuery(
  path: string,
  query: ProxyQuery,
  secrets: string[],
  options: ProxyVerifyOptions = {},
): boolean {
  return verifyProxyQueryDetailed(path, query, secrets, options).ok;
}

export interface ProxyStoreOptions extends ProxyVerifyOptions {
  store: InstallationStore;
  /**
   * Skip the single-use `jti` claim (NOT recommended; exposed for tests and
   * for apps that enforce replay themselves). Defaults to enforcing, like
   * the backend.
   */
  enforceReplay?: boolean;
}

export type ProxyVerification =
  | { ok: true; installation: InstallationRecord; params: Record<string, string> }
  | { ok: false; reason: ProxyFailure; status: 401 };

/**
 * Layer 1: verify one signed proxy query from plain data — no `Request`, no
 * framework. Resolves the installation from the existing store by the `kid`
 * routing hint (the installation p_id Queek signs in); without a `kid` it
 * falls back to trying each stored proxy secret, the signature naming the
 * sender (same rationale as the webhook resolver). Freshness is enforced
 * before attribution; a verified `jti` is claimed atomically so a captured
 * read cannot be replayed.
 */
export async function verifyProxyDelivery(
  input: { path: string; query: ProxyQuery },
  options: ProxyStoreOptions,
): Promise<ProxyVerification> {
  const fail = (reason: ProxyFailure): ProxyVerification => ({ ok: false, reason, status: 401 });
  const params = normalizeQuery(input.query);
  const { sig, ts, jti } = readProxyFields(params);
  if (sig === "" || ts === "" || jti === "" || !/^\d+$/.test(ts)) {
    return fail("missing_params");
  }
  if (proxySkewExceeded(ts, options)) {
    return fail("stale_timestamp");
  }

  const kid = params[PROXY_KID_PARAM];
  const rows = await options.store.listInstallations();
  const candidates =
    kid !== undefined && kid !== ""
      ? rows.filter((row) => row.installationPid === kid)
      : rows.filter((row) => row.proxySecret !== null && row.proxySecret !== undefined);
  if (candidates.length === 0) {
    return fail("unknown_installation");
  }
  const secrets = candidates.map((row) => row.proxySecret ?? "");
  if (secrets.length === 0 || secrets[0] === "") {
    return fail("missing_secret");
  }

  let installation: InstallationRecord | null = null;
  for (const candidate of candidates) {
    if (proxyMacMatches(input.path, params, sig, candidate.proxySecret ?? "")) {
      installation = candidate;
      break;
    }
  }
  if (!installation) {
    return fail("signature_mismatch");
  }

  if (options.enforceReplay ?? true) {
    if (!(await options.store.claimWebhookId(`proxy-jti:${jti}`))) {
      return fail("replayed");
    }
  }
  return { ok: true, installation, params };
}

export interface ProxyRequestOptions extends ProxyStoreOptions {
  /**
   * The Queek-side canonical path the backend signed
   * (`/apps/<subpath>/<rest>`, e.g. `/apps/booking/availability`) — the
   * app's local route is NOT it. Pass one per route.
   */
  path: string;
}

/** What the app answers once the query verifies (it owns the body — slots, JSON, …). */
export type ProxyResponder = (verified: {
  installation: InstallationRecord;
  params: Record<string, string>;
}) => Response | Promise<Response>;

/**
 * Layer 2: the Web-standard wrapper, built ONLY on layer 1 — reads the query
 * off the request URL, calls the core, builds the `Response`. Phase 1 is
 * read-only by binding rule (the backend only ever sends GET), so only
 * `GET` is served; anything else answers 405.
 */
export async function handleProxyRequest(
  request: Request,
  options: ProxyRequestOptions,
  onVerified: ProxyResponder,
): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") {
    return toResponse({ status: 405, body: { ok: false, error: "method_not_allowed" } });
  }
  const url = new URL(request.url);
  const query: ProxyQuery = {};
  for (const key of url.searchParams.keys()) {
    query[key] = url.searchParams.get(key);
  }
  const verified = await verifyProxyDelivery({ path: options.path, query }, options);
  if (!verified.ok) {
    const result: DeliveryResult = { status: verified.status, body: { ok: false, error: verified.reason } };
    return toResponse(result);
  }
  return onVerified({ installation: verified.installation, params: verified.params });
}
