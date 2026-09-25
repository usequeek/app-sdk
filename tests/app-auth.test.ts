import { createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APP_JWT_SKEW_SECONDS,
  APP_JWT_TTL_SECONDS,
  InvalidAppCredentialError,
  loadAppCredential,
  signAppJwt,
} from "../src/app-auth.js";
import { createLogger } from "../src/logger.js";
import { testAppKeypair } from "./fake-queek-app-api.js";

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

// One keypair per file: RSA keygen is slow, and sharing is safe here.
const KEYPAIR = testAppKeypair();

describe("app credential", () => {
  it("loads from env and rejects a missing key, kid, slug, or bad PEM", () => {
    const keypair = KEYPAIR;
    const credential = loadAppCredential({
      appSlug: keypair.slug,
      keyId: keypair.kid,
      privateKeyPem: keypair.privateKeyPem,
    });
    expect(credential).toMatchObject({ appSlug: keypair.slug, keyId: keypair.kid });

    expect(() =>
      loadAppCredential({ appSlug: "", keyId: keypair.kid, privateKeyPem: keypair.privateKeyPem }),
    ).toThrow(InvalidAppCredentialError);
    expect(() =>
      loadAppCredential({ appSlug: keypair.slug, keyId: "", privateKeyPem: keypair.privateKeyPem }),
    ).toThrow(/APP_KEY_ID/);
    expect(() => loadAppCredential({ appSlug: keypair.slug, keyId: keypair.kid, privateKeyPem: "" })).toThrow(
      /APP_PRIVATE_KEY/,
    );
    expect(() =>
      loadAppCredential({ appSlug: keypair.slug, keyId: keypair.kid, privateKeyPem: "not-a-pem" }),
    ).toThrow(InvalidAppCredentialError);
    expect(() => loadAppCredential({ env: { APP_SLUG: "x", APP_KEY_ID: "k" } as NodeJS.ProcessEnv })).toThrow(
      /APP_PRIVATE_KEY/,
    );
  });

  it("reads APP_SLUG / APP_KEY_ID / APP_PRIVATE_KEY from env", () => {
    const keypair = testAppKeypair("env-app", "env-kid");
    const credential = loadAppCredential({
      env: {
        APP_SLUG: keypair.slug,
        APP_KEY_ID: keypair.kid,
        APP_PRIVATE_KEY: keypair.privateKeyPem,
      } as NodeJS.ProcessEnv,
    });
    expect(credential.appSlug).toBe("env-app");
  });
});

describe("app JWT (RS256, node:crypto only)", () => {
  it("signs {iss, iat = now-60, exp = iat+540} with a kid header, verifiable by the public key", () => {
    const keypair = KEYPAIR;
    const credential = loadAppCredential({
      appSlug: keypair.slug,
      keyId: keypair.kid,
      privateKeyPem: keypair.privateKeyPem,
    });
    const now = 1_758_685_600;
    const jwt = signAppJwt({ credential, nowSeconds: now });
    const [headerSeg, payloadSeg, sigSeg] = jwt.split(".");
    expect(decodeSegment(headerSeg as string)).toEqual({ alg: "RS256", typ: "JWT", kid: keypair.kid });
    expect(decodeSegment(payloadSeg as string)).toEqual({
      iss: keypair.slug,
      iat: now - APP_JWT_SKEW_SECONDS,
      exp: now - APP_JWT_SKEW_SECONDS + APP_JWT_TTL_SECONDS,
    });
    // The window stays under the 600 s wire bound.
    expect(APP_JWT_TTL_SECONDS).toBeLessThanOrEqual(600);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerSeg}.${payloadSeg}`, "utf8");
    expect(verifier.verify(keypair.publicKeyPem, sigSeg as string, "base64url")).toBe(true);
  });

  it("never logs the JWT or the private key (logger redacts both shapes)", () => {
    const keypair = KEYPAIR;
    const lines: string[] = [];
    const log = createLogger({ service: "test", sink: (line) => lines.push(line) });
    const jwt = signAppJwt({
      credential: loadAppCredential({
        appSlug: keypair.slug,
        keyId: keypair.kid,
        privateKeyPem: keypair.privateKeyPem,
      }),
      nowSeconds: 1_758_685_600,
    });
    log.error("mint failed", { authorization: `Bearer ${jwt}`, key: keypair.privateKeyPem });
    log.info(`saw ${jwt} in the message`);
    const dumped = lines.join("\n");
    expect(dumped).not.toContain(jwt);
    expect(dumped).not.toContain("BEGIN PRIVATE KEY");
    expect(dumped).toContain("[redacted]");
  });
});
