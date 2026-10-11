import { randomUUID } from "node:crypto";
import type { paths } from "./merchant-schema.js";

/**
 * Typed fetch client over Queek's public Merchant API.
 *
 * - Base URL comes from the install handoff (`api_base`). Queek sends the
 *   BARE store host (e.g. `https://api.usequeek.com`); the client appends
 *   `/api/v1/merchant` when it is absent, so a bare host and a full
 *   merchant base both work. Never hardcoded otherwise, so test stores ride
 *   their own host.
 * - `apiBase` is validated at construction — https only, no credentials,
 *   host on the allowlist — and throws BEFORE any fetch, so a
 *   signed-but-stale or attacker-influenced handoff can never point
 *   `X-Client-Key` at an arbitrary host.
 * - Auth is the installation credential only: `X-Client-Key: sk_…`
 *   (server-side; the key is bound to ONE store, so no vendor id is sent).
 * - Writes (POST/PUT/PATCH/DELETE) carry an `Idempotency-Key` (generated
 *   when the caller does not supply one) because Queek's `idempotent`
 *   middleware replays same-key+same-body writes instead of duplicating
 *   them. GET/HEAD never send one.
 * - Errors are thrown as `QueekApiError`, typed from Queek's error envelope
 *   (`{error: {code, message, field?, errors?, doc_url?, request_id?}}` plus
 *   the legacy top-level `error_code`/`message`/`errors` keys — the contract
 *   is additive, so both are read). Switch on `code`, never on `message`.
 * - 429s expose `retryAfterMs` parsed from `Retry-After` (seconds or
 *   HTTP-date). Plain `request()` never retries; `requestWithRetry()`
 *   retries 429s, 502/503/504, timeouts and network errors with jittered
 *   exponential backoff and the SAME idempotency key on every attempt.
 * - Every request has a timeout (`timeoutMs`, default 30 s) and accepts an
 *   `AbortSignal`. Failures that never produced an HTTP answer are thrown as
 *   `QueekApiError` with status 0 and the code `network_error`,
 *   `request_timeout` or `request_aborted`, and the original error as `cause`.
 *
 * Typed surface: `getStore()` is typed from the app's Merchant API
 * paths. Pass the app's own codegen output as the type argument
 * (`createQueekClient<AppPaths>` / `createInstallationClient<AppPaths>`);
 * the bundled `merchant-schema.ts` stays the DEFAULT (`TPaths = paths`)
 * so existing apps compile unchanged — but the default is a compat shim,
 * not the freshness mechanism: it does NOT auto-update when the Merchant
 * API gains fields (re-run codegen in the app for current types; sunset
 * signal at 1.0). A pinned old SDK keeps working with new fields untyped
 * until bumped (the contract is additive). `request()` is the generic
 * escape hatch.
 * In-repo reference: `openapi/merchant.json` → `merchant-schema.ts` via
 * `npm run gen:merchant` (the json is NOT shipped in the published
 * package).
 */

export type MerchantPaths = paths;

/** 200 JSON body of `GET <P>` for operations shaped `{responses: {200: {content: {"application/json": T}}}}`. Over `TPaths` (default: the bundled `paths` compat shim). */
export type OperationResponse<
  P extends keyof TPaths,
  M extends keyof TPaths[P],
  TPaths = paths,
> = TPaths[P][M] extends {
  responses: { 200: { content: { "application/json": infer T } } };
}
  ? T
  : unknown;

export type StoreProfile<TPaths = paths> = "get" extends keyof TPaths[Extract<"/store", keyof TPaths>]
  ? OperationResponse<
      Extract<"/store", keyof TPaths>,
      Extract<"get", keyof TPaths[Extract<"/store", keyof TPaths>]>,
      TPaths
    >
  : unknown;

/**
 * The paths a generic client is actually typed over. An UNRESOLVED
 * `TPaths` collapses to the bundled default: TypeScript instantiates an
 * unconstrained type parameter at `unknown` (ignoring `= paths`) wherever a
 * generic function's type is inspected without type arguments, e.g.
 * `ReturnType<typeof createInstallationClient>` — the alias every app uses.
 * Without this collapse that alias is `QueekClient<unknown>`, not
 * assignable with `QueekClient`, and existing apps fail to compile on upgrade.
 */
export type ResolvedPaths<TPaths> = unknown extends TPaths ? paths : TPaths;

/** Path of the public Merchant API below the store host. */
export const MERCHANT_API_PATH = "/api/v1/merchant";

/** Hosts a handoff `api_base` may point at without extra configuration. */
export const DEFAULT_API_HOSTS = ["api.usequeek.com"];

/** Thrown at client construction when `apiBase` fails validation — before any fetch. */
export class InvalidApiBaseError extends Error {
  readonly code = "invalid_api_base";

  constructor(message: string) {
    super(message);
    this.name = "InvalidApiBaseError";
  }
}

const ENV_HOSTS_VAR = "QUEEK_API_HOSTS";
const ENV_DEV_HOSTS_VAR = "QUEEK_DEV_API_HOSTS";
const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function parseHostList(raw: string, varName: string): string[] {
  return raw.split(",").map((entry) => {
    const host = entry.trim().toLowerCase();
    if (!HOSTNAME_RE.test(host)) {
      throw new InvalidApiBaseError(
        `Invalid ${varName} entry ${JSON.stringify(entry)}: must be a bare hostname (no scheme, port or path).`,
      );
    }
    return host;
  });
}

/**
 * Extra allowed `apiBase` hosts for test and local setups, from
 * `QUEEK_API_HOSTS` (comma-separated bare hostnames). Parsed strictly: any
 * entry that is not a bare hostname throws — nothing is silently skipped.
 */
export function apiHostsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[ENV_HOSTS_VAR];
  if (raw === undefined || raw.trim() === "") return [];
  return parseHostList(raw, ENV_HOSTS_VAR);
}

/**
 * DEV-ONLY extra allowed hosts (e.g. an HTTPS tunnel to a local Queek API),
 * from `QUEEK_DEV_API_HOSTS`. REFUSED when NODE_ENV=production: a dev
 * tunnel host must never be allowlisted in production, even by accident.
 * Throws at client construction, before any fetch.
 */
export function devApiHostsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[ENV_DEV_HOSTS_VAR];
  if (raw === undefined || raw.trim() === "") return [];
  if ((env.NODE_ENV ?? "") === "production") {
    throw new InvalidApiBaseError(
      `${ENV_DEV_HOSTS_VAR} is set but NODE_ENV=production: dev tunnel hosts are refused in production.`,
    );
  }
  return parseHostList(raw, ENV_DEV_HOSTS_VAR);
}

/**
 * Validate the handoff `apiBase` and normalize it to the full merchant base.
 * Throws `InvalidApiBaseError` on: unparseable URL, non-https scheme,
 * embedded credentials, an explicit port on a DEFAULT host (production
 * hosts are 443 — ports ride only on dev/test hosts), or a host outside
 * `DEFAULT_API_HOSTS + allowedApiHosts + QUEEK_API_HOSTS +
 * QUEEK_DEV_API_HOSTS`.
 */
export function resolveApiBase(raw: string, allowedApiHosts: string[] = []): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidApiBaseError(`Invalid api_base ${JSON.stringify(raw)}: not a URL.`);
  }
  if (url.protocol !== "https:") {
    throw new InvalidApiBaseError(`Invalid api_base ${JSON.stringify(raw)}: https only.`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new InvalidApiBaseError("Invalid api_base: embedded credentials are never allowed.");
  }
  const host = url.hostname.toLowerCase();
  if (DEFAULT_API_HOSTS.includes(host) && url.port !== "") {
    throw new InvalidApiBaseError(
      `Invalid api_base ${JSON.stringify(raw)}: the production host takes no port (443).`,
    );
  }
  const allowlist = new Set([
    ...DEFAULT_API_HOSTS,
    ...allowedApiHosts.map((h) => h.toLowerCase()),
    ...apiHostsFromEnv(),
    ...devApiHostsFromEnv(),
  ]);
  if (!allowlist.has(host)) {
    throw new InvalidApiBaseError(
      `Invalid api_base host ${JSON.stringify(host)}: not on the allowlist (add test hosts via ${ENV_HOSTS_VAR}).`,
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  const merchantPath = path.endsWith(MERCHANT_API_PATH) ? path : `${path}${MERCHANT_API_PATH}`;
  return `https://${host}${url.port !== "" ? `:${url.port}` : ""}${merchantPath}`;
}

/** Default time a single HTTP attempt may take before it fails with `request_timeout`. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Default ceiling for honouring a 429 `Retry-After` inside `requestWithRetry()`. */
export const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;

export interface QueekClientOptions {
  /** Handoff `api_base` (bare store host or full merchant base). Validated at construction. */
  apiBase: string;
  /** The installation credential, sent as `X-Client-Key`. Never logged and never put in an error message. */
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Time one attempt may take, in ms (default 30000). `0` disables the client timeout. */
  timeoutMs?: number;
  /** Sent as User-Agent. Defaults to `queek-app/1.0`. */
  userAgent?: string;
  /** Extra allowed `apiBase` hosts (test/local API hosts). Production default always applies. */
  allowedApiHosts?: string[];
}

export interface RequestOptions {
  /** Query string values. `undefined` entries are skipped; everything else is URL-encoded for you. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON-serialisable request body. */
  body?: unknown;
  /** Write idempotency (POST/PUT/PATCH/DELETE). Generated when omitted. */
  idempotencyKey?: string;
  /** Correlation id sent as `X-Request-Id` (8 to 128 characters of `A-Za-z0-9_.:-`). Generated when omitted. */
  requestId?: string;
  /** Aborts the call. An aborted call fails with code `request_aborted` and is never retried. */
  signal?: AbortSignal;
  /** Overrides the client's per-attempt timeout for this call, in ms. `0` disables it. */
  timeoutMs?: number;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** True for HTTP methods that carry an `Idempotency-Key` (POST/PUT/PATCH/DELETE). */
export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

/** A fresh `Idempotency-Key` value (a random UUID). */
export function newIdempotencyKey(): string {
  return randomUUID();
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && trimmed !== "") {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

export interface QueekErrorDetails {
  status: number;
  code: string;
  message: string;
  field?: string;
  errors?: unknown;
  docUrl?: string;
  requestId?: string;
  retryAfterMs?: number;
  /** The underlying error, when this one wraps another (a failed `fetch`, for example). */
  cause?: unknown;
}

/**
 * The one error every Queek HTTP call throws. Switch on `code`, never on
 * `message`.
 *
 * Codes that come from Queek are the API's own (`validation_failed`,
 * `insufficient_scope`, `too_many_requests`, ...). Codes the SDK raises when
 * no usable HTTP answer arrived (`status` is 0 for the first three):
 * `network_error`, `request_timeout`, `request_aborted`, and
 * `invalid_response` (an HTTP success whose body was not JSON).
 *
 * `requestId` matches the `X-Request-Id` response header: quote it to Queek
 * support.
 *
 * @example
 * try {
 *   await client.request("POST", "/orders", { body });
 * } catch (error) {
 *   if (error instanceof QueekApiError && error.code === "validation_failed") {
 *     console.error(error.field, error.errors, error.requestId);
 *   }
 * }
 */
export class QueekApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field?: string;
  readonly errors?: unknown;
  readonly docUrl?: string;
  readonly requestId?: string;
  /** Set on 429s (and only there): how long to wait before retrying. */
  readonly retryAfterMs?: number;

  constructor(details: QueekErrorDetails) {
    super(details.message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "QueekApiError";
    this.status = details.status;
    this.code = details.code;
    this.field = details.field;
    this.errors = details.errors;
    this.docUrl = details.docUrl;
    this.requestId = details.requestId;
    this.retryAfterMs = details.retryAfterMs;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /**
   * True when sending the same call again can succeed without any change:
   * rate limits, gateway failures (502, 503, 504), timeouts and network
   * errors. `requestWithRetry()` retries exactly these. A caller abort is
   * never retryable.
   */
  get isRetryable(): boolean {
    return (
      this.status === 429 ||
      this.status === 502 ||
      this.status === 503 ||
      this.status === 504 ||
      this.code === "network_error" ||
      this.code === "request_timeout"
    );
  }
}

/**
 * The error for a call that never produced an HTTP answer. A caller abort is
 * `request_aborted`, the client timeout is `request_timeout`, everything else
 * (DNS, refused or reset connection, TLS) is `network_error`. The original
 * error stays on `cause`.
 */
export function transportError(cause: unknown, signal?: AbortSignal): QueekApiError {
  const name = cause instanceof Error ? cause.name : "";
  const reason = cause instanceof Error && cause.message !== "" ? ` (${cause.message})` : "";
  if (name === "TimeoutError") {
    return new QueekApiError({
      status: 0,
      code: "request_timeout",
      message:
        "Queek did not answer before the request timeout. Retry, raise `timeoutMs`, or use requestWithRetry().",
      cause,
    });
  }
  if (signal?.aborted === true) {
    return new QueekApiError({
      status: 0,
      code: "request_aborted",
      message: "The request was aborted by its AbortSignal before Queek answered.",
      cause,
    });
  }
  return new QueekApiError({
    status: 0,
    code: "network_error",
    message: `Could not reach Queek${reason}. Check the network connection and the api_base host, then retry; requestWithRetry() does this for you.`,
    cause,
  });
}

/**
 * Combine a caller signal with the per-attempt timeout. Returns the caller
 * signal untouched when `timeoutMs` is 0 or negative.
 */
export function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  if (!(timeoutMs > 0)) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * Build a `QueekApiError` from a status + parsed body + headers. Shared
 * with the installation-token mint path (`tokens.ts`), so the merchant and
 * app-credential endpoints parse errors identically.
 */
export function queekApiErrorFromResponse(status: number, body: unknown, headers: Headers): QueekApiError {
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const envelope = (typeof record.error === "object" && record.error !== null ? record.error : {}) as Record<
    string,
    unknown
  >;
  const firstString = (...candidates: unknown[]): string | undefined => {
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
    }
    return undefined;
  };
  const code =
    firstString(envelope.code, record.error_code) ?? (status === 429 ? "too_many_requests" : "server_error");
  const message =
    firstString(envelope.message, record.message) ??
    `Queek answered HTTP ${status} without an error message. Retry, and quote the request id if it persists.`;
  const details: QueekErrorDetails = {
    status,
    code,
    message,
    field: firstString(envelope.field),
    errors: (envelope.errors ?? record.errors) as unknown,
    docUrl: firstString(envelope.doc_url),
    requestId: firstString(envelope.request_id, record.request_id, headers.get("x-request-id")),
  };
  if (details.errors === undefined) delete details.errors;
  if (details.field === undefined) delete details.field;
  if (details.docUrl === undefined) delete details.docUrl;
  if (details.requestId === undefined) delete details.requestId;
  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(headers.get("retry-after"));
    if (retryAfterMs !== null) details.retryAfterMs = retryAfterMs;
  }
  return new QueekApiError(details);
}

export interface RetryOptions {
  /** Total attempts including the first (default 3). Must be >= 1. */
  maxAttempts?: number;
  /** Base backoff between attempts in ms (default 250); doubles per attempt. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms (default 5000). */
  maxDelayMs?: number;
  /**
   * Longest `Retry-After` the call will wait out, in ms (default 30000). A
   * 429 that asks for more is thrown at once instead of holding the caller.
   */
  maxRetryAfterMs?: number;
  /** Injectable clock for tests. Defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable randomness for the backoff jitter, in [0, 1). Defaults to `Math.random`. */
  random?: () => number;
}

export interface QueekClient<TPaths = paths> {
  /** `GET /store` — the handed-off key proving itself. Typed from the app's paths (`TPaths`, default: bundled shim). */
  getStore(signal?: AbortSignal): Promise<StoreProfile<TPaths>>;
  /** Generic typed escape hatch: `request<T>("GET", "/orders", { query })`. Never retries. */
  request<T>(method: string, path: string, options?: RequestOptions): Promise<T>;
  /**
   * `request()` with bounded retries on 429s, 502/503/504, timeouts and
   * network errors, with jittered exponential backoff. The SAME idempotency
   * key is reused across attempts (generated once when the caller does not
   * supply one), so a retry can never duplicate a write; a 429
   * `Retry-After` is honoured over the backoff schedule. A caller abort is
   * never retried.
   */
  requestWithRetry<T>(method: string, path: string, options?: RequestOptions & RetryOptions): Promise<T>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Milliseconds to wait before the next attempt, or `null` when the error
 * must be thrown instead of retried (not retryable, or a `Retry-After`
 * longer than `maxRetryAfterMs`). Backoff is exponential with equal jitter
 * (half fixed, half random) so many clients do not retry in lockstep.
 */
function retryDelayMs(error: QueekApiError, attempt: number, options: RetryOptions): number | null {
  if (!error.isRetryable) return null;
  if (error.isRateLimited && error.retryAfterMs !== undefined) {
    return error.retryAfterMs <= (options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS)
      ? error.retryAfterMs
      : null;
  }
  const ceiling = Math.min(options.maxDelayMs ?? 5000, (options.baseDelayMs ?? 250) * 2 ** attempt);
  const random = options.random ?? Math.random;
  return Math.floor(ceiling / 2 + (random() * ceiling) / 2);
}

/**
 * The retry loop both clients share. `run` receives the idempotency key to
 * send (generated ONCE for writes when the caller gave none), so every
 * attempt of one write carries the same key.
 */
export async function runWithRetry<T>(
  method: string,
  options: RetryOptions & { idempotencyKey?: string },
  run: (idempotencyKey: string | undefined) => Promise<T>,
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const sleep = options.sleep ?? defaultSleep;
  const idempotencyKey = options.idempotencyKey ?? (isWriteMethod(method) ? newIdempotencyKey() : undefined);
  for (let attempt = 0; ; attempt++) {
    try {
      return await run(idempotencyKey);
    } catch (error) {
      if (!(error instanceof QueekApiError) || attempt >= maxAttempts - 1) throw error;
      const delay = retryDelayMs(error, attempt, options);
      if (delay === null) throw error;
      await sleep(delay);
    }
  }
}

/**
 * Create a client for the Merchant API with one static installation key.
 * Most apps want `createInstallationClient()` instead, which mints and
 * refreshes the key for you.
 *
 * @example
 * const client = createQueekClient({ apiBase: install.api_base, apiKey: process.env.QUEEK_KEY ?? "" });
 * const store = await client.getStore();
 */
export function createQueekClient<TPaths = paths>(
  clientOptions: QueekClientOptions,
): QueekClient<ResolvedPaths<TPaths>> {
  const base = resolveApiBase(clientOptions.apiBase, clientOptions.allowedApiHosts ?? []);
  const fetchImpl = clientOptions.fetchImpl ?? fetch;
  const userAgent = clientOptions.userAgent ?? "queek-app/1.0";

  async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const upper = method.toUpperCase();
    const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    const headers = new Headers();
    headers.set("X-Client-Key", clientOptions.apiKey);
    headers.set("Accept", "application/json");
    headers.set("User-Agent", userAgent);
    headers.set("X-Request-Id", options.requestId ?? randomUUID());
    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }
    if (isWriteMethod(upper)) {
      headers.set("Idempotency-Key", options.idempotencyKey ?? newIdempotencyKey());
    }

    const signal = requestSignal(
      options.signal,
      options.timeoutMs ?? clientOptions.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(url.toString(), { method: upper, headers, body, signal });
      text = await response.text();
    } catch (cause) {
      throw transportError(cause, options.signal);
    }

    if (!response.ok) {
      throw queekApiErrorFromResponse(
        response.status,
        text === "" ? null : tryParseJson(text),
        response.headers,
      );
    }
    return parseSuccessBody<T>(response, text);
  }

  async function requestWithRetry<T>(
    method: string,
    path: string,
    options: RequestOptions & RetryOptions = {},
  ): Promise<T> {
    return runWithRetry(method, options, (idempotencyKey) =>
      request<T>(method, path, { ...options, idempotencyKey }),
    );
  }

  return {
    getStore: (signal?: AbortSignal) =>
      request<StoreProfile<ResolvedPaths<TPaths>>>("GET", "/store", { signal }),
    request,
    requestWithRetry,
  };
}

/**
 * Parse a non-JSON-safe error body: JSON when it parses, otherwise the first
 * 500 characters as the error `message`.
 */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}

/**
 * Parse an HTTP success body. An empty body is `null`; a body that is not
 * JSON is an `invalid_response` error, never a silently mistyped value.
 */
export function parseSuccessBody<T>(response: Response, text: string): T {
  if (text === "") return null as T;
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new QueekApiError({
      status: response.status,
      code: "invalid_response",
      message: `Queek answered HTTP ${response.status} with a body that is not JSON. Retry; if it persists, quote the request id to Queek support.`,
      requestId: response.headers.get("x-request-id") ?? undefined,
      cause,
    });
  }
}

/** One page of a cursor-paginated Merchant API list. */
export interface CursorPage<T> {
  data: T[];
  has_more: boolean;
  next_cursor?: string | null;
}

export interface PaginateOptions {
  /** Extra query parameters (filters, sort). `limit` and `starting_after` are managed for you. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Rows per page. Each endpoint documents its own maximum. */
  limit?: number;
  signal?: AbortSignal;
  /** Retry tuning for each page fetch. */
  retry?: RetryOptions;
}

/**
 * Iterate every row of a cursor-paginated list (`data`, `has_more`,
 * `next_cursor`, driven by `starting_after`), fetching one page at a time
 * with `requestWithRetry()`. Stops when `has_more` is false.
 *
 * @example
 * for await (const order of paginate<{ p_id: string }>(client, "/orders", { limit: 50 })) {
 *   console.log(order.p_id);
 * }
 */
export async function* paginate<T>(
  client: Pick<QueekClient<unknown>, "requestWithRetry">,
  path: string,
  options: PaginateOptions = {},
): AsyncGenerator<T, void, undefined> {
  let cursor: string | undefined;
  while (true) {
    const page: CursorPage<T> = await client.requestWithRetry<CursorPage<T>>("GET", path, {
      ...options.retry,
      query: { ...options.query, limit: options.limit, starting_after: cursor },
      signal: options.signal,
    });
    yield* page.data;
    if (!page.has_more) return;
    if (typeof page.next_cursor !== "string" || page.next_cursor === "" || page.next_cursor === cursor) {
      throw new QueekApiError({
        status: 200,
        code: "invalid_response",
        message: `Queek reported more rows for ${path} but sent no new next_cursor, so paging stopped. Retry; if it persists, quote the request id to Queek support.`,
      });
    }
    cursor = page.next_cursor;
  }
}
