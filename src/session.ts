import { decodeProtectedHeader, jwtVerify } from "jose";

/**
 * Dashboard session tokens (S4 stage 2): short-lived HS256 JWTs the backend
 * mints per installation for the framed merchant page. The app backend
 * verifies them with the per-installation `embsec_…` secret before trusting
 * any call that carries one.
 *
 * Server-only: the secret must never enter a browser bundle, so this module
 * ships behind the `./server` export, not the main entry. Style mirrors
 * `signatures.ts` — a boolean fast path plus a detailed variant returning
 * `{ ok } | { ok: false, reason }`.
 */

export const EMBED_SECRET_PREFIX = "embsec_";

/** The only JWS algorithm the dashboard mints (HS256 over the embsec_ secret). */
export const SESSION_TOKEN_ALG = "HS256";

/** Backend skew the verifier tolerates (matches the mint side). */
export const SESSION_CLOCK_TOLERANCE_SECONDS = 20;

export type SessionTokenFailure =
  | "missing_token"
  | "missing_secret"
  | "wrong_algorithm"
  | "invalid_signature"
  | "expired"
  | "not_yet_valid"
  | "wrong_audience"
  | "wrong_issuer"
  | "binding_mismatch";

export interface SessionTokenClaims {
  installationId: string;
  vendorId: string;
  appSlug: string;
  appId: string;
  subject: string;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface SessionTokenBinding {
  installationId: string;
  vendorId: string;
  appSlug: string;
  appId: string;
}

export interface VerifySessionTokenOptions {
  /** The per-installation `embsec_…` secret, raw UTF-8 bytes (never decoded). */
  secret: string;
  /** Single expected audience: the app slug. */
  audience: string;
  /** Expected issuer: the Queek api_base. */
  issuer: string;
  /**
   * The installation row the token must belong to (the app backend's own
   * record). Every field is compared — a token minted for another
   * installation fails closed even when its signature and audience check
   * out, mirroring the backend `verify()`.
   */
  expected: SessionTokenBinding;
  clockToleranceSeconds?: number;
}

export async function verifySessionToken(
  token: string,
  options: VerifySessionTokenOptions,
): Promise<boolean> {
  const result = await verifySessionTokenDetailed(token, options);
  return result.ok;
}

export async function verifySessionTokenDetailed(
  token: string,
  options: VerifySessionTokenOptions,
): Promise<{ ok: true; claims: SessionTokenClaims } | { ok: false; reason: SessionTokenFailure }> {
  if (!token) {
    return { ok: false, reason: "missing_token" };
  }
  const { secret, audience, issuer } = options;
  if (!secret?.startsWith(EMBED_SECRET_PREFIX)) {
    return { ok: false, reason: "missing_secret" };
  }
  // Fail closed on the algorithm before jose sees the token: a foreign alg
  // (none, RS256, …) is rejected here with wrong_algorithm regardless of
  // how jose shapes the downstream error (key-type TypeError vs
  // JOSEAlgNotAllowed). An undecodable header falls through to jwtVerify,
  // which rejects it as invalid_signature.
  const headerAlg = readTokenAlg(token);
  if (headerAlg !== null && headerAlg !== SESSION_TOKEN_ALG) {
    return { ok: false, reason: "wrong_algorithm" };
  }

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
      audience,
      issuer,
      clockTolerance: options.clockToleranceSeconds ?? SESSION_CLOCK_TOLERANCE_SECONDS,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    return { ok: false, reason: classifyJoseError(error) };
  }

  const claims = readSessionClaims(payload);
  const { expected } = options;
  if (
    !claims ||
    claims.installationId !== expected.installationId ||
    claims.vendorId !== expected.vendorId ||
    claims.appSlug !== expected.appSlug ||
    claims.appId !== expected.appId
  ) {
    return { ok: false, reason: "binding_mismatch" };
  }
  return { ok: true, claims };
}

/**
 * The token's `alg` without verifying anything. Returns null when the
 * header is missing or undecodable, so malformed tokens keep flowing to
 * jwtVerify (invalid_signature) instead of being mislabelled.
 */
function readTokenAlg(token: string): string | null {
  try {
    const alg = decodeProtectedHeader(token).alg;
    return typeof alg === "string" ? alg : null;
  } catch {
    return null;
  }
}

function readSessionClaims(payload: Record<string, unknown>): SessionTokenClaims | null {
  const pick = (key: string): string | null =>
    typeof payload[key] === "string" && (payload[key] as string).length > 0 ? (payload[key] as string) : null;
  const installationId = pick("installation_id");
  const vendorId = pick("vendor_id");
  const appSlug = pick("app_slug");
  const appId = pick("app_id");
  const subject = typeof payload.sub === "string" ? payload.sub : null;
  const sessionId = pick("sid");
  const issuedAt = typeof payload.iat === "number" ? payload.iat : null;
  const expiresAt = typeof payload.exp === "number" ? payload.exp : null;
  if (
    !installationId ||
    !vendorId ||
    !appSlug ||
    !appId ||
    !subject ||
    !sessionId ||
    issuedAt === null ||
    expiresAt === null
  ) {
    return null;
  }
  return { installationId, vendorId, appSlug, appId, subject, sessionId, issuedAt, expiresAt };
}

function classifyJoseError(error: unknown): SessionTokenFailure {
  // Exact jose v6 pins (verified against jose@6.2.12 — codes, names, and
  // the `claim` field probed, not guessed): claim failures carry code
  // ERR_JWT_CLAIM_VALIDATION_FAILED and name the claim; expiry also
  // surfaces as JWTExpired / ERR_JWT_EXPIRED; algorithm refusal is
  // JOSEAlgNotAllowed / ERR_JOSE_ALG_NOT_ALLOWED (unreachable in practice —
  // the header pre-check fails closed first). Anything else — JWSInvalid,
  // JWSSignatureVerificationFailed, key TypeErrors, garbage input — is an
  // invalid signature. No fuzzy matching: a renamed jose error must fall
  // through loudly, not hide behind a regex.
  const shaped = error as { code?: unknown; name?: unknown; claim?: unknown };
  const claim = typeof shaped?.claim === "string" ? shaped.claim : "";
  if (claim === "exp") {
    return "expired";
  }
  if (claim === "nbf") {
    return "not_yet_valid";
  }
  if (claim === "aud") {
    return "wrong_audience";
  }
  if (claim === "iss") {
    return "wrong_issuer";
  }
  const code = typeof shaped?.code === "string" ? shaped.code : "";
  if (code === "ERR_JWT_EXPIRED") {
    return "expired";
  }
  if (code === "ERR_JOSE_ALG_NOT_ALLOWED") {
    return "wrong_algorithm";
  }
  const name = typeof shaped?.name === "string" ? shaped.name : "";
  if (name === "JWTExpired") {
    return "expired";
  }
  if (name === "JOSEAlgNotAllowed") {
    return "wrong_algorithm";
  }
  return "invalid_signature";
}
