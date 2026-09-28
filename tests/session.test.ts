import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import * as mainEntry from "../src/index.js";
import * as serverEntry from "../src/server.js";
import {
  EMBED_SECRET_PREFIX,
  SESSION_CLOCK_TOLERANCE_SECONDS,
  sessionTokenInstallationId,
  verifySessionToken,
  verifySessionTokenDetailed,
} from "../src/session.js";

/**
 * Dashboard session-token verification (S4 stage 2): the app backend's view
 * of the token the dashboard mints. Round-trip uses a locally signed token
 * with the exact contract (HS256, slug audience, api_base issuer, 60s TTL,
 * installation binding); every negative the backend enforces has a case
 * here, plus the server-entry boundary (the secret never ships to browsers).
 */

const SECRET = `${EMBED_SECRET_PREFIX}test-secret-for-session-tokens-only`;
const AUDIENCE = "booker";
const ISSUER = "https://api.example.com";

const BINDING = {
  installation_id: "install-uuid-1",
  vendor_id: "vendor-uuid-1",
  app_slug: AUDIENCE,
  app_id: "app-uuid-1",
} as const;

async function signValid(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: "user-uuid-1",
    sid: "sid-uuid-1",
    jti: "jti-uuid-1",
    ...BINDING,
    ...overrides,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 60)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .sign(new TextEncoder().encode(SECRET));
}

const OPTIONS = {
  secret: SECRET,
  audience: AUDIENCE,
  issuer: ISSUER,
  expected: {
    installationId: BINDING.installation_id,
    vendorId: BINDING.vendor_id,
    appSlug: BINDING.app_slug,
    appId: BINDING.app_id,
  },
};

describe("verifySessionToken", () => {
  it("verifies a contract-shaped token and returns the binding", async () => {
    const token = await signValid();
    expect(await verifySessionToken(token, OPTIONS)).toBe(true);
    const detailed = await verifySessionTokenDetailed(token, OPTIONS);
    expect(detailed).toEqual({
      ok: true,
      claims: {
        installationId: BINDING.installation_id,
        vendorId: BINDING.vendor_id,
        appSlug: BINDING.app_slug,
        appId: BINDING.app_id,
        subject: "user-uuid-1",
        sessionId: "sid-uuid-1",
        issuedAt: expect.any(Number),
        expiresAt: expect.any(Number),
      },
    });
  });

  it("refuses an empty token and a non-embed secret", async () => {
    expect(await verifySessionToken("", OPTIONS)).toBe(false);
    expect(await verifySessionTokenDetailed("x.y.z", { ...OPTIONS, secret: "whsec_wrong-prefix" })).toEqual({
      ok: false,
      reason: "missing_secret",
    });
  });

  it("refuses swapped identity bindings with a valid signature", async () => {
    for (const [name, claims] of [
      ["app_id", { app_id: "app-uuid-other" }],
      ["vendor_id", { vendor_id: "vendor-uuid-other" }],
      ["app_slug", { app_slug: "glovo" }],
      ["installation_id", { installation_id: "install-uuid-other" }],
    ] as const) {
      const token = await signValid(claims as Record<string, unknown>);
      const result = await verifySessionTokenDetailed(token, OPTIONS);
      expect(result, name).toEqual({ ok: false, reason: "binding_mismatch" });
    }
  });

  it("refuses wrong audience, issuer, expired, and early tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await signValid();
    const expiredToken = await new SignJWT({
      ...JSON.parse(Buffer.from(expired.split(".")[1], "base64url").toString()),
      exp: now - 61,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(new TextEncoder().encode(SECRET));
    expect((await verifySessionTokenDetailed(expiredToken, OPTIONS)).reason).toBe("expired");

    const early = await new SignJWT({ sub: "u", sid: "s", jti: "j", ...BINDING })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(now + 120)
      .setNotBefore(now + 120)
      .setExpirationTime(now + 180)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .sign(new TextEncoder().encode(SECRET));
    expect((await verifySessionTokenDetailed(early, OPTIONS)).reason).toBe("not_yet_valid");

    const valid = await signValid();
    expect((await verifySessionTokenDetailed(valid, { ...OPTIONS, audience: "glovo" })).reason).toBe(
      "wrong_audience",
    );
    expect(
      (await verifySessionTokenDetailed(valid, { ...OPTIONS, issuer: "https://evil.example.com" })).reason,
    ).toBe("wrong_issuer");
  });

  it("refuses none-alg and foreign-alg tokens against the HS256 pin", async () => {
    // Exact pins: the header pre-check fails closed with wrong_algorithm
    // before jose runs, so neither the none header nor the RS256 key-type
    // TypeError underneath can hide behind a disjunction.
    const now = Math.floor(Date.now() / 1000);
    const b64url = (raw: string): string => Buffer.from(raw).toString("base64url");
    const payload = b64url(
      JSON.stringify({
        sub: "u",
        sid: "s",
        jti: "j",
        ...BINDING,
        iat: now,
        nbf: now,
        exp: now + 60,
        iss: ISSUER,
        aud: AUDIENCE,
      }),
    );
    const noneToken = `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${payload}.`;
    expect(await verifySessionTokenDetailed(noneToken, OPTIONS)).toEqual({
      ok: false,
      reason: "wrong_algorithm",
    });

    const { privateKey } = await generateKeyPair("RS256");
    const rs256 = await new SignJWT({ sub: "u", sid: "s", jti: "j", ...BINDING })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 60)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .sign(privateKey);
    expect(await verifySessionTokenDetailed(rs256, OPTIONS)).toEqual({
      ok: false,
      reason: "wrong_algorithm",
    });
  });

  it("refuses a valid-shaped token signed by the wrong secret", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: "u", sid: "s", jti: "j", ...BINDING })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 60)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .sign(new TextEncoder().encode(`${EMBED_SECRET_PREFIX}attacker-secret`));
    expect((await verifySessionTokenDetailed(token, OPTIONS)).reason).toBe("invalid_signature");
  });

  it("ships the verifier behind ./server only, never the browser entry", () => {
    expect(typeof serverEntry.verifySessionToken).toBe("function");
    expect(typeof serverEntry.verifySessionTokenDetailed).toBe("function");
    expect("verifySessionToken" in mainEntry).toBe(false);
    expect("verifySessionTokenDetailed" in mainEntry).toBe(false);
  });

  it("pins the backend-matching clock tolerance", () => {
    expect(SESSION_CLOCK_TOLERANCE_SECONDS).toBe(20);
  });

  it("reads the installation routing hint without trusting it", async () => {
    const token = await signValid();
    expect(sessionTokenInstallationId(token)).toBe(BINDING.installation_id);
    // A forged token still yields its claim: the hint routes, the verify decides.
    const forged = `${token.split(".").slice(0, 2).join(".")}.${"A".repeat(43)}`;
    expect(sessionTokenInstallationId(forged)).toBe(BINDING.installation_id);
    expect(
      await verifySessionToken(forged, {
        secret: SECRET,
        audience: AUDIENCE,
        issuer: ISSUER,
        expected: {
          installationId: BINDING.installation_id,
          vendorId: BINDING.vendor_id,
          appSlug: BINDING.app_slug,
          appId: BINDING.app_id,
        },
      }),
    ).toBe(false);
    for (const junk of ["", "not-a-jwt", "a.b.c", await signValid({ installation_id: "" })]) {
      expect(sessionTokenInstallationId(junk)).toBeNull();
    }
    expect(Object.keys(serverEntry)).toContain("sessionTokenInstallationId");
    expect(Object.keys(mainEntry)).not.toContain("sessionTokenInstallationId");
  });
});
