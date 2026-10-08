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
 *   retries 429s and network errors with the SAME idempotency key.
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

export interface QueekClientOptions {
  /** Handoff `api_base` (bare store host or full merchant base). Validated at construction. */
  apiBase: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Sent as User-Agent. Defaults to `queek-app/1.0`. */
  userAgent?: string;
  /** Extra allowed `apiBase` hosts (test/local API hosts). Production default always applies. */
  allowedApiHosts?: string[];
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Write idempotency (POST/PUT/PATCH/DELETE). Generated when omitted. */
  idempotencyKey?: string;
  requestId?: string;
  signal?: AbortSignal;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** True for HTTP methods that carry an `Idempotency-Key` (POST/PUT/PATCH/DELETE). */
export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

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
}

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
    super(details.message);
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
  const message = firstString(envelope.message, record.message) ?? `Queek API error ${status}`;
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
  /** Backoff ceiling in ms (default 5000). A 429 `Retry-After` can exceed it. */
  maxDelayMs?: number;
  /** Injectable clock for tests. Defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface QueekClient<TPaths = paths> {
  /** `GET /store` — the handed-off key proving itself. Typed from the app's paths (`TPaths`, default: bundled shim). */
  getStore(signal?: AbortSignal): Promise<StoreProfile<TPaths>>;
  /** Generic typed escape hatch: `request<T>("GET", "/orders", { query })`. Never retries. */
  request<T>(method: string, path: string, options?: RequestOptions): Promise<T>;
  /**
   * `request()` with bounded retries on 429s and network errors. The SAME
   * idempotency key is reused across attempts (generated once when the
   * caller does not supply one), so a retry can never duplicate a write;
   * a 429 `Retry-After` is honoured over the backoff schedule.
   */
  requestWithRetry<T>(method: string, path: string, options?: RequestOptions & RetryOptions): Promise<T>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: unknown): boolean {
  return error instanceof QueekApiError && (error.isRateLimited || error.code === "network_error");
}

function retryDelayMs(
  error: QueekApiError,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  if (error.isRateLimited && error.retryAfterMs !== undefined) return error.retryAfterMs;
  return Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
}

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

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), { method: upper, headers, body, signal: options.signal });
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
    return parsed as T;
  }

  async function requestWithRetry<T>(
    method: string,
    path: string,
    options: RequestOptions & RetryOptions = {},
  ): Promise<T> {
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
    const baseDelayMs = options.baseDelayMs ?? 250;
    const maxDelayMs = options.maxDelayMs ?? 5000;
    const sleep = options.sleep ?? defaultSleep;
    // One key for every attempt: Queek replays same-key+same-body writes
    // instead of duplicating them, so retrying a write is safe.
    const idempotencyKey =
      options.idempotencyKey ?? (isWriteMethod(method) ? newIdempotencyKey() : undefined);
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await request<T>(method, path, { ...options, idempotencyKey });
      } catch (error) {
        lastError = error;
        const retryable = error instanceof QueekApiError && isRetryable(error);
        if (!retryable || attempt === maxAttempts - 1) throw error;
        await sleep(retryDelayMs(error as QueekApiError, attempt, baseDelayMs, maxDelayMs));
      }
    }
    throw lastError;
  }

  return {
    getStore: (signal?: AbortSignal) =>
      request<StoreProfile<ResolvedPaths<TPaths>>>("GET", "/store", { signal }),
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
