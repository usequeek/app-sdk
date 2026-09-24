import { randomUUID } from "node:crypto";
import type { paths } from "./merchant-schema.js";

/**
 * Typed fetch client over Queek's public Merchant API.
 *
 * - Base URL comes from the install handoff (`api_base`), e.g.
 *   `https://api.usequeek.com/api/v1/merchant` — never hardcoded, so test
 *   stores ride their own host.
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
 *   HTTP-date). The client does NOT sleep-and-retry writes on its own:
 *   retry with the SAME idempotency key after `retryAfterMs`.
 *
 * Typed surface: `getStore()` is typed from the generated Merchant API
 * schema (`openapi/merchant.json` → `merchant-schema.ts` via
 * `pnpm gen:merchant`); `request()` is the generic escape hatch.
 */

export type MerchantPaths = paths;

/** 200 JSON body of `GET <P>` for operations shaped `{responses: {200: {content: {"application/json": T}}}}`. */
export type OperationResponse<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends {
  responses: { 200: { content: { "application/json": infer T } } };
}
  ? T
  : unknown;

export type StoreProfile = OperationResponse<"/store", "get">;

export interface QueekClientOptions {
  apiBase: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Sent as User-Agent. Defaults to `queek-app/1.0`. */
  userAgent?: string;
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

function errorFromBody(status: number, body: unknown, headers: Headers): QueekApiError {
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

export interface QueekClient {
  /** `GET /store` — the handed-off key proving itself. Typed from the Merchant API schema. */
  getStore(signal?: AbortSignal): Promise<StoreProfile>;
  /** Generic typed escape hatch: `request<T>("GET", "/orders", { query })`. */
  request<T>(method: string, path: string, options?: RequestOptions): Promise<T>;
}

export function createQueekClient(clientOptions: QueekClientOptions): QueekClient {
  const base = clientOptions.apiBase.replace(/\/+$/, "");
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
    if (WRITE_METHODS.has(upper)) {
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
      throw errorFromBody(response.status, parsed, response.headers);
    }
    return parsed as T;
  }

  return {
    getStore: (signal?: AbortSignal) => request<StoreProfile>("GET", "/store", { signal }),
    request,
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}
