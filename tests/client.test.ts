import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiHostsFromEnv,
  createQueekClient,
  InvalidApiBaseError,
  QueekApiError,
  resolveApiBase,
} from "../src/client.js";

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

describe("api_base validation (https + allowlist, before any fetch)", () => {
  afterEach(() => {
    delete process.env.QUEEK_API_HOSTS;
  });

  it.each([
    "http://api.usequeek.com/api/v1/merchant",
    "http://api.usequeek.com",
    "https://evil.example.com/api/v1/merchant",
    "https://api.usequeek.com.evil.io/api/v1/merchant",
    "https://api.usequeek.com@evil.io/api/v1/merchant",
    "https://user:pass@api.usequeek.com/api/v1/merchant",
    "not-a-url",
    "",
  ])("rejects %s without fetching", (apiBase) => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { data: {} }));
    expect(() => createQueekClient({ apiBase, apiKey: API_KEY, fetchImpl })).toThrow(InvalidApiBaseError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts the allowed host and normalizes a bare handoff host to the merchant base", async () => {
    // What the backend really sends: rtrim(config('app.url')) verbatim
    // (AppInstallService::installPayload, queek_backend) — a bare host.
    expect(resolveApiBase("https://api.usequeek.com")).toBe("https://api.usequeek.com/api/v1/merchant");
    expect(resolveApiBase("https://api.usequeek.com/")).toBe("https://api.usequeek.com/api/v1/merchant");
    expect(resolveApiBase("https://api.usequeek.com/api/v1/merchant")).toBe(
      "https://api.usequeek.com/api/v1/merchant",
    );
    const fetchImpl = mockFetch((url) => {
      expect(url).toBe("https://api.usequeek.com/api/v1/merchant/store");
      return jsonResponse(200, { data: { p_id: "store_xyz" } });
    });
    const client = createQueekClient({ apiBase: "https://api.usequeek.com", apiKey: API_KEY, fetchImpl });
    await client.getStore();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("admits env-configured test hosts, strictly parsed", () => {
    process.env.QUEEK_API_HOSTS = "backend.test, staging.example.com";
    expect(apiHostsFromEnv()).toEqual(["backend.test", "staging.example.com"]);
    expect(resolveApiBase("https://backend.test")).toBe("https://backend.test/api/v1/merchant");
    process.env.QUEEK_API_HOSTS = "https://backend.test";
    expect(() => apiHostsFromEnv()).toThrow(/bare hostname/);
    process.env.QUEEK_API_HOSTS = "backend.test:8443";
    expect(() => apiHostsFromEnv()).toThrow(/bare hostname/);
    process.env.QUEEK_API_HOSTS = "";
    expect(apiHostsFromEnv()).toEqual([]);
  });

  it("admits explicit allowedApiHosts without env", () => {
    const client = createQueekClient({
      apiBase: "https://apps.test.local",
      apiKey: API_KEY,
      allowedApiHosts: ["apps.test.local"],
      fetchImpl: mockFetch(() => jsonResponse(200, { data: {} })),
    });
    expect(client).toBeDefined();
  });
});

describe("requestWithRetry (same Idempotency-Key, honours Retry-After)", () => {
  function keysOf(calls: Array<{ init: RequestInit }>): (string | null)[] {
    return calls.map((call) => new Headers(call.init.headers).get("Idempotency-Key"));
  }

  it("retries a 429 once and reuses the key", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    const fetchImpl = mockFetch((_url, init) => {
      calls.push({ init });
      return calls.length === 1
        ? jsonResponse(
            429,
            { error: { code: "too_many_requests", message: "Slow." } },
            { "Retry-After": "0" },
          )
        : jsonResponse(200, { data: { id: "order-1" } });
    });
    const sleeps: number[] = [];
    const client = createQueekClient({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl });
    const result = await client.requestWithRetry<{ data: { id: string } }>("POST", "/orders", {
      body: { a: 1 },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    expect(result).toEqual({ data: { id: "order-1" } });
    expect(calls).toHaveLength(2);
    const keys = keysOf(calls);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(sleeps).toEqual([0]);
  });

  it("retries network errors with backoff, then succeeds", async () => {
    let attempts = 0;
    const fetchImpl = mockFetch(() => {
      attempts += 1;
      if (attempts < 3) throw new TypeError("fetch failed");
      return jsonResponse(200, { data: {} });
    });
    const sleeps: number[] = [];
    const client = createQueekClient({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl });
    await client.requestWithRetry("POST", "/orders", {
      body: {},
      baseDelayMs: 100,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it("does not retry auth failures and stops after maxAttempts", async () => {
    const forbidden = mockFetch(() => jsonResponse(403, { error: { code: "forbidden", message: "No." } }));
    const client = createQueekClient({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl: forbidden });
    await expect(client.requestWithRetry("GET", "/store")).rejects.toMatchObject({ code: "forbidden" });
    expect(forbidden).toHaveBeenCalledTimes(1);

    const always429 = mockFetch(() =>
      jsonResponse(429, { error: { code: "too_many_requests", message: "Slow." } }),
    );
    const client2 = createQueekClient({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl: always429 });
    await expect(
      client2.requestWithRetry("GET", "/store", { maxAttempts: 2, baseDelayMs: 1, sleep: async () => {} }),
    ).rejects.toMatchObject({ code: "too_many_requests" });
    expect(always429).toHaveBeenCalledTimes(2);
  });
});
