import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createProxyHandler } from "../src/hono.js";
import {
  buildProxyCanonicalString,
  handleProxyRequest,
  signProxyQuery,
  verifyProxyDelivery,
  verifyProxyQuery,
  verifyProxyQueryDetailed,
} from "../src/proxy.js";
import { type InstallationRecord, SqliteInstallationStore } from "../src/store.js";
import { fakeSecret } from "./helpers.js";

/**
 * App-proxy query verification against Queek's
 * `App\Services\Apps\AppProxyService::signQuery()/verifyQuery()`.
 *
 * BACKEND_VECTOR was produced by the BACKEND's signer
 * (`APP_ENV=testing php artisan tinker --execute` in the
 * review-flow worktree: `signQuery("/apps/booking/availability",
 * "store_xyz", ["date" => "2026-10-01", "slot" => "09:00"], $secret,
 * $installation(p_id 424242), 1767225600)` with
 * `$secret = fakeSecret("proxy-backend")` rebuilt there as
 * `whsec_`.`base64("fake-secret-proxy-backend")`) and is pinned here — if
 * the two sides ever disagree, this test goes red.
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

describe("backend-exact canonical string + HMAC (tinker vector)", () => {
  it("builds the canonical string exactly like AppProxyService::signature()", () => {
    expect(buildProxyCanonicalString(PATH, BACKEND_PARAMS)).toBe(
      "/apps/booking/availability\n" +
        "store_xyz\n" +
        "1767225600\n" +
        "date=2026-10-01&jti=f0021d03-637c-4e82-a425-e6d3e60c02b5&kid=424242&shop=store_xyz&slot=09%3A00&ts=1767225600",
    );
  });

  it("recomputes the backend's sig byte-for-byte", () => {
    expect(signProxyQuery(PATH, BACKEND_PARAMS, BACKEND_SECRET)).toBe(BACKEND_SIG);
  });

  it("keys the HMAC by the FULL secret string (no base64 decode step)", () => {
    const expected = createHmac("sha256", BACKEND_SECRET)
      .update(buildProxyCanonicalString(PATH, BACKEND_PARAMS), "utf8")
      .digest("hex");
    expect(signProxyQuery(PATH, BACKEND_PARAMS, BACKEND_SECRET)).toBe(expected);
  });

  it("verifies the backend-signed query", () => {
    expect(verifyProxyQuery(PATH, BACKEND_QUERY, [BACKEND_SECRET], { nowSeconds: NOW })).toBe(true);
  });
});

describe("verifyProxyQuery semantics (mirroring verifyQuery)", () => {
  it("rejects tampered params", () => {
    expect(
      verifyProxyQueryDetailed(
        PATH,
        { ...BACKEND_QUERY, date: "2026-10-02" },
        [BACKEND_SECRET],
        { nowSeconds: NOW },
      ),
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

  it("floors the skew at 60s like the backend's max(60, …)", () => {
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

  it("requires a non-empty first secret (backend quirk, mirrored)", () => {
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
