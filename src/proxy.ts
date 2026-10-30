import { createHmac, timingSafeEqual } from "node:crypto";
import { type DeliveryResult, toResponse } from "./delivery.js";
import { type InstallationRecord, type InstallationStore, normalisePid } from "./store.js";

/**
 * Storefront app-proxy query verification, byte-for-byte compatible with
 * the way Queek signs proxy reads.
 *
 * Queek signs a READ fetch to the app's proxy handler with the installation's
 * `proxy_secret`: the app verifies server-side before answering the
 * shopper. Canonical signature (per-installation secret):
 *
 *   sig = hex HMAC-SHA256 over
 *     path + "\n" + shop + "\n" + ts + "\n" + sorted(k=v&...) (sig excluded),
 *
 * where each pair is `encode(key)=encode(value)` (RFC 3986 percent-encoding) and keys sort
 * byte-wise. The HMAC key is the FULL `whsec_…` string — no base64 decode
 * step (the single most common integration bug cannot happen here).
 *
 * `path` is the QUEEK-side canonical path (`/apps/<subpath>/<rest>`, the
 * path Queek signs), NOT the app's local route: pass it explicitly per
 * route (see `handleProxyRequest`).
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
export const PROXY_SURFACE_PARAM = "surface";

/**
 * The Queek surface that made a call. Queek signs it on every proxy call and
 * is the only one that sets it: a shopper cannot choose it. `storefront` is a
 * shopper, `dashboard` the merchant dashboard, `ai` Queek AI reading a tool.
 */
export type ProxySurface = "storefront" | "dashboard" | "ai";

/** Default allowed clock skew in seconds; the floor (60s) below applies regardless. */
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
  | "surface_mismatch"
  | "replayed";

/** RFC 3986 percent-encoding: everything except `[A-Za-z0-9-_.~]` is `%XX` (upper-case hex), the encoding Queek signs with. */
function proxyEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => {
    return `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
  });
}

/** Scalar query values as strings, as Queek's signer reads them: null becomes `""`, an array contributes its first value, everything else stringifies. `undefined` means absent. */
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
 * The canonical string the MAC covers, exactly as Queek builds it (sig
 * excluded, keys byte-sorted, percent-encoded pairs).
 */
export function buildProxyCanonicalString(path: string, params: Record<string, string>): string {
  const sorted = { ...params };
  delete sorted[PROXY_SIGNATURE_PARAM];
  const keys = Object.keys(sorted).sort();
  const pairs = keys.map((key) => `${proxyEncode(key)}=${proxyEncode(sorted[key] as string)}`);
  return `${path}\n${sorted[PROXY_SHOP_PARAM] ?? ""}\n${sorted[PROXY_TIMESTAMP_PARAM] ?? ""}\n${pairs.join("&")}`;
}

/**
 * One hex signature for one secret, computed as Queek computes it.
 * Exported so tests (and dev harnesses) can recompute a signature
 * independently of the verifier; production traffic is signed by Queek.
 */
export function signProxyQuery(path: string, params: Record<string, string>, secret: string): string {
  return createHmac("sha256", secret).update(buildProxyCanonicalString(path, params), "utf8").digest("hex");
}

export interface ProxyVerifyOptions {
  /**
   * Require this signed `surface`. A call signed for another surface (or for
   * none) fails with `surface_mismatch`, after its signature verified. Set it
   * on a handler that serves merchant data (`dashboard`) so a shopper's call
   * cannot reach it.
   */
  expectedSurface?: ProxySurface;
  /** Unix seconds to judge freshness against (defaults to now). Exposed for tests. */
  nowSeconds?: number;
  /** Allowed clock skew in seconds (defaults to PROXY_MAX_SKEW_SECONDS; floored at 60). */
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

/** The signed surface, or `""` when the call carries none. Trust it only after the MAC verified. */
function signedSurface(params: Record<string, string>): string {
  return params[PROXY_SURFACE_PARAM] ?? "";
}

function surfaceAllowed(params: Record<string, string>, options: ProxyVerifyOptions): boolean {
  return options.expectedSurface === undefined || signedSurface(params) === options.expectedSurface;
}

function proxyMacMatches(path: string, params: Record<string, string>, sig: string, secret: string): boolean {
  if (secret === "") return false;
  const expected = signProxyQuery(path, params, secret);
  const expectedBuf = Buffer.from(expected, "utf8");
  const candidateBuf = Buffer.from(sig, "utf8");
  return candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf);
}

/**
 * Pure verification over explicitly passed secrets (structure → skew →
 * secret presence → MAC over every active secret). No replay enforcement
 * here: single-use `jti` needs storage, so the store-backed
 * `verifyProxyDelivery` claims it atomically.
 */
export function verifyProxyQueryDetailed(
  path: string,
  query: ProxyQuery,
  secrets: string[],
  options: ProxyVerifyOptions = {},
): { ok: true; surface: string } | { ok: false; reason: ProxyFailure } {
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
      return surfaceAllowed(params, options)
        ? { ok: true, surface: signedSurface(params) }
        : { ok: false, reason: "surface_mismatch" };
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
   * for apps that enforce replay themselves). Defaults to enforcing.
   */
  enforceReplay?: boolean;
}

export type ProxyVerification =
  | { ok: true; installation: InstallationRecord; params: Record<string, string>; surface: string }
  | { ok: false; reason: ProxyFailure; status: 401 | 403 };

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
  const fail = (reason: ProxyFailure, status: 401 | 403 = 401): ProxyVerification => ({
    ok: false,
    reason,
    status,
  });
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
  // Normalise the routing hint before comparing: stored pids are canonical
  // integer strings, but the hint may arrive as a JSON integer or a
  // non-canonical decimal string (`"1021.0"`); canonical strings compare
  // exactly as before.
  const candidates =
    kid !== undefined && kid !== ""
      ? rows.filter((row) => row.installationPid === normalisePid(kid))
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

  // A genuine signature for another surface is forbidden, not unauthenticated.
  if (!surfaceAllowed(params, options)) {
    return fail("surface_mismatch", 403);
  }

  if (options.enforceReplay ?? true) {
    if (!(await options.store.claimWebhookId(`proxy-jti:${jti}`))) {
      return fail("replayed");
    }
  }
  return { ok: true, installation, params, surface: signedSurface(params) };
}

/** The query of a Web `Request`, duplicates collapsing to the first value like `URLSearchParams.get`. */
function requestQuery(request: Request): ProxyQuery {
  const url = new URL(request.url);
  const query: ProxyQuery = {};
  for (const key of url.searchParams.keys()) {
    query[key] = url.searchParams.get(key);
  }
  return query;
}

export interface ProxyRequestOptions extends ProxyStoreOptions {
  /**
   * The Queek-side canonical path Queek signed
   * (`/apps/<subpath>/<rest>`, e.g. `/apps/booking/availability`) — the
   * app's local route is NOT it. Pass one per route.
   */
  path: string;
}

/** What the app answers once the query verifies (it owns the body — slots, JSON, …). */
export type ProxyResponder = (verified: {
  installation: InstallationRecord;
  params: Record<string, string>;
  surface: string;
}) => Response | Promise<Response>;

/**
 * Layer 2: the Web-standard wrapper, built ONLY on layer 1 — reads the query
 * off the request URL, calls the core, builds the `Response`. Proxy reads
 * are read-only (Queek only ever sends GET), so only `GET` is served;
 * anything else answers 405.
 */
export async function handleProxyRequest(
  request: Request,
  options: ProxyRequestOptions,
  onVerified: ProxyResponder,
): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") {
    return toResponse({ status: 405, body: { ok: false, error: "method_not_allowed" } });
  }
  const query = requestQuery(request);
  const verified = await verifyProxyDelivery({ path: options.path, query }, options);
  if (!verified.ok) {
    const result: DeliveryResult = { status: verified.status, body: { ok: false, error: verified.reason } };
    return toResponse(result);
  }
  // A responder serves storefront and dashboard calls. An AI call is served only by a declared tool handler.
  if (verified.surface === "ai") {
    return toResponse({ status: 403, body: { ok: false, error: "forbidden" } });
  }
  return onVerified({
    installation: verified.installation,
    params: verified.params,
    surface: verified.surface,
  });
}

/** A verified call to a declared AI read tool: Queek's signed params, the tool key and the actor's ROLE (never a user id). */
export interface AiToolCall {
  /** The installation p_id the call is for (the signed `kid`). */
  kid: string;
  shop: string;
  /** Everything Queek signed: the tool's inputs as strings, `kid`, `shop`, `ts`, `actor_role` and the rest. */
  params: Record<string, string>;
  tool: string;
  actorRole: string;
}

/**
 * What a tool answers: an OBJECT matching its manifest `ai.tools[].output`, never a bare array. A list tool
 * (`output.list: true`) answers `{ rows: [{ ...declared fields }] }`; any other tool answers the declared fields
 * object. Queek drops every undeclared field. (`length?: never` is what keeps an array out of the type.)
 */
export type AiToolOutput = { [field: string]: unknown; length?: never };

export type AiToolHandler = (call: AiToolCall) => Promise<AiToolOutput> | AiToolOutput;

export interface AiToolRequestOptions extends Omit<ProxyVerifyOptions, "expectedSurface"> {
  /** The manifest `extensions.proxy.subpath`; the signed path is `/apps/<subpath>/ai/<tool>`. */
  subpath: string;
  /** The active proxy secrets of installation `kid`, current first (empty when unknown). */
  secrets: (kid: string) => Promise<string[]> | string[];
  /** The read tools the manifest `ai.tools` declares, by key. Only these are served. */
  tools: Record<string, AiToolHandler>;
  /**
   * Makes each call single-use: when given, a verified call's `jti` is claimed atomically in this store, exactly as
   * `verifyProxyDelivery` does, and a replay answers 401 `replayed`. Pass the installation store. Without it a
   * captured call can be replayed inside the skew window.
   */
  replayStore?: Pick<InstallationStore, "claimWebhookId">;
}

/**
 * Layer 2 for Queek AI read tools (manifest `ai.tools`): `GET ai/{tool}` signed with `surface=ai`. The signature and
 * the surface are verified first (401, or 403 for a genuine call signed for another surface). `surface=ai` is served
 * only by a declared tool handler (403 for an undeclared key), a storefront or dashboard call at this path is
 * refused, and an AI call never reaches `handleProxyRequest`'s responder. A handler that answers anything but an
 * object (a bare array, a scalar) is answered 500. Pass `replayStore` to make each call single-use; a tool only
 * reads, so without it a replay inside the skew window repeats nothing but the read.
 */
export async function handleAiToolRequest(
  request: Request,
  tool: string,
  options: AiToolRequestOptions,
): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") {
    return toResponse({ status: 405, body: { ok: false, error: "method_not_allowed" } });
  }
  const { subpath, secrets, tools, replayStore, ...verifyOptions } = options;
  const query = requestQuery(request);
  const params = normalizeQuery(query);
  const kid = params[PROXY_KID_PARAM] ?? "";
  const verified = verifyProxyQueryDetailed(`/apps/${subpath}/ai/${tool}`, query, await secrets(kid), {
    ...verifyOptions,
    expectedSurface: "ai",
  });
  if (!verified.ok) {
    return toResponse({
      status: verified.reason === "surface_mismatch" ? 403 : 401,
      body: { ok: false, error: verified.reason },
    });
  }
  if (replayStore && !(await replayStore.claimWebhookId(`proxy-jti:${params[PROXY_NONCE_PARAM]}`))) {
    return toResponse({ status: 401, body: { ok: false, error: "replayed" } });
  }
  const handler = Object.hasOwn(tools, tool) ? tools[tool] : undefined;
  if (!handler) {
    return toResponse({ status: 403, body: { ok: false, error: "forbidden" } });
  }
  const output: unknown = await handler({
    kid,
    shop: params[PROXY_SHOP_PARAM] ?? "",
    params,
    tool,
    actorRole: params.actor_role ?? "",
  });
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return toResponse({ status: 500, body: { ok: false, error: "invalid_tool_output" } });
  }
  return toResponse({
    status: 200,
    body: output,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}
