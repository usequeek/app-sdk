import { describe, expect, it, vi } from "vitest";
import { createQueekClient, QueekApiError } from "../src/client.js";

const API_BASE = "https://api.usequeek.com/api/v1/merchant";
const API_KEY = "sk_test_installation_key";

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const request = url instanceof Request ? url : new Request(url.toString(), init);
    const merged: RequestInit = {
      method: request.method,
      headers: request.headers,
      body: init?.body ?? (await request.text().catch(() => undefined)),
      signal: init?.signal ?? request.signal,
    };
    return handler(request.url, merged);
  });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("queek client", () => {
  it("sends X-Client-Key and hits the handoff api_base on GET /store", async () => {
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toBe(`${API_BASE}/store`);
      expect(new Headers(init.headers).get("X-Client-Key")).toBe(API_KEY);
      return jsonResponse(200, { data: { p_id: "store_xyz", name: "Test" } });
    });
    const client = createQueekClient({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl });
    const store = await client.getStore();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store).toEqual({ data: { p_id: "store_xyz", name: "Test" } });
  });

  it("auto-generates an Idempotency-Key on writes, never on reads", async () => {
    const seen: Record<string, string | null> = {};
    const fetchImpl = mockFetch((url, init) => {
      const headers = new Headers(init.headers);
      seen[`${init.method} ${new URL(url).pathname}`] = headers.get("Idempotency-Key");
      return jsonResponse(200, { data: {} });
    });
    const client = createQueekClient({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl });
    await client.request("POST", "/orders", { body: { a: 1 } });
    await client.request("GET", "/orders");
    const postKey = seen["POST /api/v1/merchant/orders"];
    expect(postKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen["GET /api/v1/merchant/orders"]).toBeNull();
  });

  it("passes through a caller-supplied Idempotency-Key", async () => {
    const fetchImpl = mockFetch((_url, init) => {
      expect(new Headers(init.headers).get("Idempotency-Key")).toBe("order-1-attempt-2");
      return jsonResponse(200, { data: {} });
    });
    const client = createQueekClient({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl });
    await client.request("POST", "/orders", { body: { a: 1 }, idempotencyKey: "order-1-attempt-2" });
  });

  it("maps the Queek error envelope to a typed error (switch on code)", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse(403, {
        status: "failed",
        error_code: "insufficient_scope",
        message: "legacy message",
        data: null,
        error: {
          code: "insufficient_scope",
          message: "This key cannot grant merchant-orders-read.",
          doc_url: "https://api.usequeek.com/docs/merchant",
          request_id: "req_123",
        },
      }),
    );
    const client = createQueekClient({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl });
    const failure = await client.getStore().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueekApiError);
    const apiError = failure as QueekApiError;
    expect(apiError.status).toBe(403);
    expect(apiError.code).toBe("insufficient_scope");
    expect(apiError.requestId).toBe("req_123");
    expect(apiError.isAuthFailure).toBe(true);
    expect(apiError.isRateLimited).toBe(false);
  });

  it("falls back to legacy top-level keys when the envelope is absent", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse(401, { status: "failed", error_code: "invalid_client_key", message: "Bad key." }),
    );
    const client = createQueekClient({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl });
    const apiError = (await client.getStore().catch((error: unknown) => error)) as QueekApiError;
    expect(apiError.code).toBe("invalid_client_key");
    expect(apiError.message).toBe("Bad key.");
  });

  it("parses Retry-After seconds on 429", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse(
        429,
        { error: { code: "too_many_requests", message: "Slow down." } },
        { "Retry-After": "30" },
      ),
    );
    const client = createQueekClient({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl });
    const apiError = (await client.getStore().catch((error: unknown) => error)) as QueekApiError;
    expect(apiError.isRateLimited).toBe(true);
    expect(apiError.retryAfterMs).toBe(30_000);
  });

  it("parses an HTTP-date Retry-After on 429", async () => {
    const date = new Date(Date.now() + 45_000).toUTCString();
    const fetchImpl = mockFetch(() =>
      jsonResponse(
        429,
        { error: { code: "too_many_requests", message: "Slow down." } },
        { "Retry-After": date },
      ),
    );
    const client = createQueekClient({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl });
    const apiError = (await client.getStore().catch((error: unknown) => error)) as QueekApiError;
    expect(apiError.retryAfterMs).toBeGreaterThan(30_000);
    expect(apiError.retryAfterMs).toBeLessThanOrEqual(45_000);
  });

  it("maps network failures to code network_error (status 0)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = createQueekClient({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl });
    const apiError = (await client.getStore().catch((error: unknown) => error)) as QueekApiError;
    expect(apiError.code).toBe("network_error");
    expect(apiError.status).toBe(0);
  });
});
