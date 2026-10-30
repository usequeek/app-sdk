import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAiToolHandler, createProxyHandler } from "../src/hono.js";
import {
  type AiToolHandler,
  buildProxyCanonicalString,
  handleAiToolRequest,
  handleProxyRequest,
  signProxyQuery,
  verifyProxyDelivery,
  verifyProxyQuery,
  verifyProxyQueryDetailed,
} from "../src/proxy.js";
import { type InstallationRecord, SqliteInstallationStore } from "../src/store.js";
import { fakeSecret } from "./helpers.js";

/**
 * App-proxy query verification against Queek's signing format.
 *
 * The BACKEND_* vector was produced by Queek's own signer for the path
 * "/apps/booking/availability", shop "store_xyz", params
 * `date=2026-10-01` and `slot=09:00`, installation p_id 424242, ts
 * 1767225600, keyed by `fakeSecret("proxy-backend")` (that is,
 * `whsec_` + `base64("fake-secret-proxy-backend")`) and is pinned here —
 * if the two sides ever disagree, this test goes red.
 */

const PATH = "/apps/booking/availability";
const BACKEND_SECRET = fakeSecret("proxy-backend");
const BACKEND_PARAMS = {
  date: "2026-10-01",
  slot: "09:00",
  shop: "store_xyz",
  ts: "1767225600",
  jti: "f0021d03-637c-4e82-a425-e6d3e60c02b5",
  kid: "424242",
};
const BACKEND_SIG = "c12fc653e37d67265a3dcbfb38518e1bea5fa6dea86a6a8ea3805adb56b6ba85";
const BACKEND_QUERY = { ...BACKEND_PARAMS, sig: BACKEND_SIG };
const NOW = 1767225600;

const STORE_KEY = Buffer.alloc(32, 11).toString("base64");

function record(overrides: Partial<InstallationRecord> = {}): InstallationRecord {
  const now = new Date().toISOString();
  return {
    installationId: "11111111-1111-1111-1111-111111111111",
    installationPid: "424242",
    vendorId: "22222222-2222-2222-2222-222222222222",
    storePid: "store_xyz",
    storeName: "Test Store",
    apiBase: "https://api.usequeek.com/api/v1/merchant",
    token: null,
    tokenExpiresAt: null,
    tokenKid: null,
    pending: false,
    scopes: [],
    settings: {},
    webhookSecret: null,
    proxySecret: BACKEND_SECRET,
    embedSecret: null,
    appId: null,
    webhookUrl: null,
    webhookTopics: [],
    installedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("canonical string + HMAC match Queek's signer (pinned vector)", () => {
  it("builds the canonical string exactly like Queek", () => {
    expect(buildProxyCanonicalString(PATH, BACKEND_PARAMS)).toBe(
      "/apps/booking/availability\n" +
        "store_xyz\n" +
        "1767225600\n" +
        "date=2026-10-01&jti=f0021d03-637c-4e82-a425-e6d3e60c02b5&kid=424242&shop=store_xyz&slot=09%3A00&ts=1767225600",
    );
  });

  it("recomputes Queek's sig byte-for-byte", () => {
    expect(signProxyQuery(PATH, BACKEND_PARAMS, BACKEND_SECRET)).toBe(BACKEND_SIG);
  });

  it("keys the HMAC by the FULL secret string (no base64 decode step)", () => {
    const expected = createHmac("sha256", BACKEND_SECRET)
      .update(buildProxyCanonicalString(PATH, BACKEND_PARAMS), "utf8")
      .digest("hex");
    expect(signProxyQuery(PATH, BACKEND_PARAMS, BACKEND_SECRET)).toBe(expected);
  });

  it("verifies the Queek-signed query", () => {
    expect(verifyProxyQuery(PATH, BACKEND_QUERY, [BACKEND_SECRET], { nowSeconds: NOW })).toBe(true);
  });
});

describe("verifyProxyQuery semantics (mirroring verifyQuery)", () => {
  it("rejects tampered params", () => {
    expect(
      verifyProxyQueryDetailed(PATH, { ...BACKEND_QUERY, date: "2026-10-02" }, [BACKEND_SECRET], {
        nowSeconds: NOW,
      }),
    ).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a wrong secret but accepts rotation grace (any secret in the list)", () => {
    const options = { nowSeconds: NOW };
    expect(verifyProxyQuery(PATH, BACKEND_QUERY, [fakeSecret("wrong")], options)).toBe(false);
    expect(verifyProxyQuery(PATH, BACKEND_QUERY, [fakeSecret("wrong"), BACKEND_SECRET], options)).toBe(true);
    expect(verifyProxyQuery(PATH, BACKEND_QUERY, [BACKEND_SECRET, fakeSecret("wrong")], options)).toBe(true);
  });

  it("enforces timestamp skew exactly (fresh at 300s, stale at 301s)", () => {
    const at = (now: number) => verifyProxyQuery(PATH, BACKEND_QUERY, [BACKEND_SECRET], { nowSeconds: now });
    expect(at(NOW + 300)).toBe(true);
    expect(at(NOW + 301)).toBe(false);
    expect(
      verifyProxyQueryDetailed(PATH, BACKEND_QUERY, [BACKEND_SECRET], { nowSeconds: NOW + 1800 }),
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("floors the skew at 60s (max(60, …))", () => {
    const params = { ...BACKEND_QUERY, ts: String(NOW - 61) };
    const res = signProxyQuery(PATH, { ...BACKEND_PARAMS, ts: String(NOW - 61) }, BACKEND_SECRET);
    const query = { ...params, sig: res };
    expect(verifyProxyQuery(PATH, query, [BACKEND_SECRET], { nowSeconds: NOW, maxSkewSeconds: 10 })).toBe(
      false,
    );
    expect(
      verifyProxyQueryDetailed(PATH, query, [BACKEND_SECRET], { nowSeconds: NOW, maxSkewSeconds: 10 }),
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects missing sig/ts/jti and non-digit ts", () => {
    const { sig: _sig, ...noSig } = BACKEND_QUERY;
    expect(verifyProxyQueryDetailed(PATH, noSig, [BACKEND_SECRET], { nowSeconds: NOW })).toEqual({
      ok: false,
      reason: "missing_params",
    });
    expect(
      verifyProxyQueryDetailed(PATH, { ...BACKEND_QUERY, ts: "yesterday" }, [BACKEND_SECRET], {
        nowSeconds: NOW,
      }),
    ).toEqual({ ok: false, reason: "missing_params" });
  });

  it("requires a non-empty first secret (mirrors Queek's verifier)", () => {
    const options = { nowSeconds: NOW };
    expect(verifyProxyQuery(PATH, BACKEND_QUERY, [], options)).toBe(false);
    expect(verifyProxyQuery(PATH, BACKEND_QUERY, ["", BACKEND_SECRET], options)).toBe(false);
  });
});

describe("verifyProxyDelivery (store-backed layer 1)", () => {
  function seeded(extra: Partial<InstallationRecord> = {}) {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    store.saveInstallation(record(extra));
    return store;
  }

  it("resolves the installation by kid and returns the verified params", async () => {
    const store = seeded();
    const result = await verifyProxyDelivery(
      { path: PATH, query: BACKEND_QUERY },
      { store, nowSeconds: NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.installation.installationId).toBe("11111111-1111-1111-1111-111111111111");
    expect(result.installation.installationPid).toBe("424242");
    expect(result.params).toMatchObject({ shop: "store_xyz", date: "2026-10-01", slot: "09:00" });
  });

  it('matches the kid across pid forms ("1021" vs 1021 vs "1021.0")', async () => {
    const store = seeded({ installationPid: "1021" });
    const kids: unknown[] = ["1021", 1021, "1021.0"];
    let n = 0;
    for (const kid of kids) {
      const params = { ...BACKEND_PARAMS, kid, jti: `kid-form-${n++}` } as unknown as Record<string, string>;
      const query = { ...params, sig: signProxyQuery(PATH, params, BACKEND_SECRET) };
      const result = await verifyProxyDelivery(
        { path: PATH, query: query as unknown as Parameters<typeof verifyProxyDelivery>[0]["query"] },
        { store, nowSeconds: NOW },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`expected ok for kid ${String(kid)}`);
      expect(result.installation.installationPid).toBe("1021");
    }
  });

  it("rejects a replayed jti (single-use inside the skew window)", async () => {
    const store = seeded();
    const options = { store, nowSeconds: NOW };
    expect((await verifyProxyDelivery({ path: PATH, query: BACKEND_QUERY }, options)).ok).toBe(true);
    expect(await verifyProxyDelivery({ path: PATH, query: BACKEND_QUERY }, options)).toEqual({
      ok: false,
      reason: "replayed",
      status: 401,
    });
    expect(
      (await verifyProxyDelivery({ path: PATH, query: BACKEND_QUERY }, { ...options, enforceReplay: false }))
        .ok,
    ).toBe(true);
  });

  it("answers unknown_installation for an unstored kid", async () => {
    const store = seeded();
    const params = { ...BACKEND_PARAMS, kid: "000000" };
    const query = { ...params, sig: signProxyQuery(PATH, params, BACKEND_SECRET) };
    expect(await verifyProxyDelivery({ path: PATH, query }, { store, nowSeconds: NOW })).toEqual({
      ok: false,
      reason: "unknown_installation",
      status: 401,
    });
  });

  it("answers missing_secret when the installation holds no proxy secret", async () => {
    const store = seeded({ installationPid: "777", proxySecret: null });
    const params = { ...BACKEND_PARAMS, kid: "777" };
    const query = { ...params, sig: signProxyQuery(PATH, params, fakeSecret("anything")) };
    expect(await verifyProxyDelivery({ path: PATH, query }, { store, nowSeconds: NOW })).toEqual({
      ok: false,
      reason: "missing_secret",
      status: 401,
    });
  });

  it("falls back to trying each stored secret when no kid rides along", async () => {
    const store = seeded();
    const params = { ...BACKEND_PARAMS, jti: "11111111-2222-4333-8444-555555555555" };
    const { kid: _kid, ...noKid } = params;
    const query = { ...noKid, sig: signProxyQuery(PATH, noKid, BACKEND_SECRET) };
    const result = await verifyProxyDelivery({ path: PATH, query }, { store, nowSeconds: NOW });
    expect(result.ok).toBe(true);
  });
});

describe("handleProxyRequest (layer 2: Request in, Response out)", () => {
  const OPTIONS = { path: PATH, nowSeconds: NOW };

  function getUrl(query: Record<string, string>) {
    return `http://localhost/proxy/availability?${new URLSearchParams(query).toString()}`;
  }

  it("serves a verified GET through onVerified", async () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    store.saveInstallation(record());
    const response = await handleProxyRequest(
      new Request(getUrl(BACKEND_QUERY), { method: "GET" }),
      { store, ...OPTIONS },
      ({ installation, params }) =>
        Response.json({ ok: true, store: installation.storePid, date: params.date }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, store: "store_xyz", date: "2026-10-01" });
  });

  it("answers 401 on a tampered query and 405 off GET", async () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    store.saveInstallation(record());
    const tampered = await handleProxyRequest(
      new Request(getUrl({ ...BACKEND_QUERY, date: "2026-10-02" }), { method: "GET" }),
      { store, ...OPTIONS, enforceReplay: false },
      () => Response.json({ ok: true }),
    );
    expect(tampered.status).toBe(401);
    expect(await tampered.json()).toEqual({ ok: false, error: "signature_mismatch" });

    const wrongMethod = await handleProxyRequest(
      new Request(getUrl(BACKEND_QUERY), { method: "POST" }),
      { store, ...OPTIONS, enforceReplay: false },
      () => Response.json({ ok: true }),
    );
    expect(wrongMethod.status).toBe(405);
  });
});

describe("createProxyHandler (layer 3: hono)", () => {
  it("verifies through the thin wrapper with the same behaviour", async () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    store.saveInstallation(record());
    const params = new URLSearchParams(BACKEND_QUERY).toString();
    const app = createProxyHandler({
      store,
      path: PATH,
      nowSeconds: NOW,
      onVerified: ({ installation }) => Response.json({ ok: true, store: installation.storePid }),
    });
    const good = await app.request(`/proxy/availability?${params}`, { method: "GET" });
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ ok: true, store: "store_xyz" });

    const fresh = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    fresh.saveInstallation(record());
    const badParams = new URLSearchParams({ ...BACKEND_QUERY, sig: "0".repeat(64) }).toString();
    const bad = await createProxyHandler({
      store: fresh,
      path: PATH,
      nowSeconds: NOW,
      onVerified: () => Response.json({ ok: true }),
    }).request(`/proxy/availability?${badParams}`, { method: "GET" });
    expect(bad.status).toBe(401);
  });
});

/**
 * The signed `surface` (storefront | dashboard | ai). Queek sets it on every
 * call and a shopper cannot choose it, so a handler can tell its dashboard
 * call from a request crafted to look like one. The two vectors were computed
 * with PHP's `hash_hmac` over the canonical string Queek's signer builds, with
 * `surface` among the signed pairs.
 */
describe("signed surface", () => {
  const SURFACE_SECRET = "whsec_MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIz";
  const SURFACE_PATH = "/apps/booking/dashboard/blocks/card";
  const SURFACE_NOW = 1790000000;

  function surfaceQuery(surface: string, sig: string): Record<string, string> {
    return {
      order_id: "1042",
      vendor_id: "77",
      surface,
      shop: "my-store",
      ts: String(SURFACE_NOW),
      jti: "jti-1",
      kid: "55",
      sig,
    };
  }

  const DASHBOARD = surfaceQuery(
    "dashboard",
    "ea49d4f12297e6f2b58c9d1b3a202c67e6656b38c49180dad73b0dfc4f2e6335",
  );
  const STOREFRONT = surfaceQuery(
    "storefront",
    "4f8584875848046506426d691f22fea27085e6918f46a0debcbab50a06ad6588",
  );
  const at = { nowSeconds: SURFACE_NOW };

  it("matches Queek's signer byte for byte, surface included", () => {
    expect(signProxyQuery(SURFACE_PATH, DASHBOARD, SURFACE_SECRET)).toBe(DASHBOARD.sig);
    expect(signProxyQuery(SURFACE_PATH, STOREFRONT, SURFACE_SECRET)).toBe(STOREFRONT.sig);
  });

  it("returns the signed surface from a verified query", () => {
    expect(verifyProxyQueryDetailed(SURFACE_PATH, DASHBOARD, [SURFACE_SECRET], at)).toEqual({
      ok: true,
      surface: "dashboard",
    });
  });

  it("lets a handler require a surface, and refuses a genuine call signed for another", () => {
    const options = { ...at, expectedSurface: "dashboard" } as const;
    expect(verifyProxyQuery(SURFACE_PATH, DASHBOARD, [SURFACE_SECRET], options)).toBe(true);
    expect(verifyProxyQueryDetailed(SURFACE_PATH, STOREFRONT, [SURFACE_SECRET], options)).toEqual({
      ok: false,
      reason: "surface_mismatch",
    });
  });

  it("refuses a surface changed after signing, and a missing surface when one is required", () => {
    const spoofed = { ...STOREFRONT, surface: "dashboard" };
    expect(
      verifyProxyQueryDetailed(SURFACE_PATH, spoofed, [SURFACE_SECRET], {
        ...at,
        expectedSurface: "dashboard",
      }),
    ).toEqual({ ok: false, reason: "signature_mismatch" });
    const { surface: _drop, ...unsigned } = DASHBOARD;
    const sig = signProxyQuery(SURFACE_PATH, unsigned, SURFACE_SECRET);
    expect(
      verifyProxyQueryDetailed(SURFACE_PATH, { ...unsigned, sig }, [SURFACE_SECRET], {
        ...at,
        expectedSurface: "dashboard",
      }),
    ).toEqual({ ok: false, reason: "surface_mismatch" });
    expect(verifyProxyQuery(SURFACE_PATH, { ...unsigned, sig }, [SURFACE_SECRET], at)).toBe(true);
  });

  it("answers 403 for a surface mismatch in the store-backed layer, and keeps the jti unused", async () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    store.saveInstallation(record({ installationPid: "55", proxySecret: SURFACE_SECRET }));
    const input = { path: SURFACE_PATH, query: STOREFRONT };
    expect(await verifyProxyDelivery(input, { store, ...at, expectedSurface: "dashboard" })).toEqual({
      ok: false,
      reason: "surface_mismatch",
      status: 403,
    });
    const retried = await verifyProxyDelivery(input, { store, ...at, expectedSurface: "storefront" });
    expect(retried.ok).toBe(true);
    if (retried.ok) expect(retried.surface).toBe("storefront");
  });

  it("never hands a surface=ai call to a storefront or dashboard responder", async () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    store.saveInstallation(record({ installationPid: "55", proxySecret: SURFACE_SECRET }));
    const params = { ...DASHBOARD, surface: "ai" };
    const query = { ...params, sig: signProxyQuery(SURFACE_PATH, params, SURFACE_SECRET) };
    let reached = false;
    const response = await handleProxyRequest(
      new Request(`http://localhost/proxy/x?${new URLSearchParams(query)}`),
      { store, path: SURFACE_PATH, ...at },
      () => {
        reached = true;
        return Response.json({ ok: true });
      },
    );
    expect(response.status).toBe(403);
    expect(reached).toBe(false);
  });
});

describe("Queek AI read tools (handleAiToolRequest, createAiToolHandler)", () => {
  const SUBPATH = "booking";
  const secrets = (kid: string) => (kid === "424242" ? [BACKEND_SECRET] : []);

  /** A signed `GET ai/{tool}` URL as Queek sends it. */
  function toolUrl(
    tool: string,
    surface: string,
    params: Record<string, string> = {},
    jti = "ai-jti-1",
  ): string {
    const signed: Record<string, string> = {
      ...params,
      surface,
      actor_role: "owner",
      shop: "store_xyz",
      ts: String(NOW),
      jti,
      kid: "424242",
    };
    const query = { ...signed, sig: signProxyQuery(`/apps/${SUBPATH}/ai/${tool}`, signed, BACKEND_SECRET) };
    return `http://localhost/proxy/ai/${tool}?${new URLSearchParams(query)}`;
  }

  function call(tool: string, url: string, tools: Record<string, AiToolHandler>) {
    return handleAiToolRequest(new Request(url), tool, { subpath: SUBPATH, secrets, tools, nowSeconds: NOW });
  }

  it("serves a declared tool to a signed surface=ai call: an object, the call's role and inputs", async () => {
    let seen: {
      tool: string;
      actorRole: string;
      days: string | undefined;
      kid: string;
      shop: string;
    } | null = null;
    const tools: Record<string, AiToolHandler> = {
      upcoming_bookings: (toolCall) => {
        seen = {
          tool: toolCall.tool,
          actorRole: toolCall.actorRole,
          days: toolCall.params.days,
          kid: toolCall.kid,
          shop: toolCall.shop,
        };
        return { rows: [{ date: "2026-10-31", service: "Wash" }] };
      },
    };
    const response = await call(
      "upcoming_bookings",
      toolUrl("upcoming_bookings", "ai", { days: "3" }),
      tools,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toEqual({ rows: [{ date: "2026-10-31", service: "Wash" }] });
    expect(seen).toEqual({
      tool: "upcoming_bookings",
      actorRole: "owner",
      days: "3",
      kid: "424242",
      shop: "store_xyz",
    });
  });

  it("refuses an undeclared tool, and a storefront or dashboard call at the tool path (403)", async () => {
    const tools: Record<string, AiToolHandler> = { upcoming_bookings: () => ({ rows: [] }) };
    for (const tool of ["delete_everything", "constructor", "__proto__", "toString"]) {
      expect((await call(tool, toolUrl(tool, "ai"), tools)).status).toBe(403);
    }
    for (const surface of ["storefront", "dashboard"]) {
      const crossed = await call("upcoming_bookings", toolUrl("upcoming_bookings", surface), tools);
      expect(crossed.status).toBe(403);
      expect(await crossed.json()).toEqual({ ok: false, error: "surface_mismatch" });
    }
  });

  it("answers 401 for a forged signature, a stale call and an unknown installation, and never reaches the tool", async () => {
    let reached = false;
    const tools: Record<string, AiToolHandler> = {
      upcoming_bookings: () => {
        reached = true;
        return { rows: [] };
      },
    };
    const forged = new URL(toolUrl("upcoming_bookings", "ai"));
    forged.searchParams.set("sig", "0".repeat(64));
    expect((await call("upcoming_bookings", forged.toString(), tools)).status).toBe(401);

    const stale = await handleAiToolRequest(
      new Request(toolUrl("upcoming_bookings", "ai")),
      "upcoming_bookings",
      {
        subpath: SUBPATH,
        secrets,
        tools,
        nowSeconds: NOW + 3600,
      },
    );
    expect(stale.status).toBe(401);

    const unknown = await handleAiToolRequest(
      new Request(toolUrl("upcoming_bookings", "ai")),
      "upcoming_bookings",
      {
        subpath: SUBPATH,
        secrets: () => [],
        tools,
        nowSeconds: NOW,
      },
    );
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ ok: false, error: "missing_secret" });
    expect(reached).toBe(false);
  });

  it("answers an object, never a bare array or a scalar (500 invalid_tool_output)", async () => {
    const tools = {
      bare: () => [{ date: "2026-10-31" }],
      scalar: () => 7,
      nothing: () => null,
    } as unknown as Record<string, AiToolHandler>;
    for (const tool of Object.keys(tools)) {
      const response = await call(tool, toolUrl(tool, "ai"), tools);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ ok: false, error: "invalid_tool_output" });
    }
    // The type already refuses a bare array.
    // @ts-expect-error an array is not an AiToolOutput
    const typed: AiToolHandler = () => [];
    expect(typed).toBeTypeOf("function");
  });

  it("claims the jti when a replay store is given: the same call twice is 401 replayed", async () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    const options = {
      subpath: SUBPATH,
      secrets,
      nowSeconds: NOW,
      replayStore: store,
      tools: { upcoming_bookings: () => ({ rows: [] }) },
    };
    const url = toolUrl("upcoming_bookings", "ai");
    const first = await handleAiToolRequest(new Request(url), "upcoming_bookings", options);
    expect(first.status).toBe(200);
    const replay = await handleAiToolRequest(new Request(url), "upcoming_bookings", options);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ ok: false, error: "replayed" });
    // Without a replay store the same call still serves (the read-only default).
    const { replayStore: _drop, ...open } = options;
    expect((await handleAiToolRequest(new Request(url), "upcoming_bookings", open)).status).toBe(200);
    // A forged call never burns a jti.
    const forged = new URL(toolUrl("upcoming_bookings", "ai", {}, "ai-jti-forged"));
    forged.searchParams.set("sig", "0".repeat(64));
    expect((await handleAiToolRequest(new Request(forged), "upcoming_bookings", options)).status).toBe(401);
    expect(await store.claimWebhookId("proxy-jti:ai-jti-forged")).toBe(true);
  });

  it("serves GET only", async () => {
    const response = await handleAiToolRequest(
      new Request(toolUrl("upcoming_bookings", "ai"), { method: "POST" }),
      "upcoming_bookings",
      { subpath: SUBPATH, secrets, tools: { upcoming_bookings: () => ({ rows: [] }) }, nowSeconds: NOW },
    );
    expect(response.status).toBe(405);
  });

  it("mounts under /ai with the hono wrapper", async () => {
    const app = createAiToolHandler({
      subpath: SUBPATH,
      secrets,
      nowSeconds: NOW,
      tools: { upcoming_bookings: () => ({ rows: [{ service: "Wash" }] }) },
    });
    const url = new URL(toolUrl("upcoming_bookings", "ai"));
    const response = await app.request(`/upcoming_bookings${url.search}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rows: [{ service: "Wash" }] });
  });
});
