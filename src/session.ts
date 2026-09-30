import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";

/**
 * Dashboard session tokens (S4 stage 2): short-lived HS256 JWTs the backend
 * mints per installation for the framed merchant page. The app backend
 * verifies them with the per-installation `embsec_…` secret before trusting
 * any call that carries one.
 *
 * Purpose binding (backend contract, mirrored from
 * `AppSessionTokenService::verify()`): absent or "session" is a bridge
 * token, verified by `verifySessionToken`; "launch" is the signed
 * first-load token, verified ONLY by `verifyLaunchToken` as the input to
 * the app's launch exchange (exchange it once for the app's own session so
 * the first paint needs no bridge round-trip). Each verifier refuses the
 * other's purpose with the same failure path callers map to 401, so a
 * launch token that rode a URL can never be replayed as a bridge token
 * and vice versa.
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
  | "wrong_purpose"
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

/**
 * Launch-token claims: the bridge binding plus the launch-only hints the
 * backend mints for the signed first load — the store p_id (the URL-safe
 * store id) and the dashboard theme for a flash-free first paint. Both are
 * hints, not auth: `storePid` is null when the mint carried none, `theme`
 * is null unless the mint carried exactly `light` or `dark`.
 */
export interface LaunchTokenClaims extends SessionTokenClaims {
  storePid: number | null;
  theme: "light" | "dark" | null;
}

export interface VerifySessionTokenOptions {
  /** The per-installation `embsec_…` secret, raw UTF-8 bytes (never decoded). */
  secret: string;
  /** Single expected audience: the app slug. */
  audience: string;
  /**
   * Expected issuer: the handoff `api_base` VERBATIM
   * (`installation.apiBase` — it equals the bare `app.url` the backend
   * signs as `iss`). Never a prefix or a suffix of it.
   */
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
  const envelope = await verifyTokenEnvelope(token, options);
  if (!envelope.ok) return envelope;

  const { payload } = envelope;
  // Purpose binding (backend contract): absent or "session" is a bridge
  // token; "launch" belongs to the signed first-load exchange only and is
  // refused here with the same failure path callers map to 401. Any other
  // present purpose fails closed as well — the bridge verifier accepts
  // exactly the bridge purposes, never a foreign one.
  if (!isBridgePurpose(payload.purpose)) {
    return { ok: false, reason: "wrong_purpose" };
  }

  const claims = readSessionClaims(payload);
  const { expected } = options;
  if (!claims || !bindingMatches(claims, expected)) {
    return { ok: false, reason: "binding_mismatch" };
  }
  return { ok: true, claims };
}

/**
 * Server-side launch exchange input (signed first load): verify a
 * purpose=launch token with the SAME checks as the bridge verifier
 * (signature, audience, issuer, installation binding, expiry) plus the
 * purpose pin — anything but exactly `"launch"` is refused with
 * `wrong_purpose`, so a bridge token can never open the exchange. On
 * success the app mints its own session from the claims (subject, store,
 * theme) and the first paint needs no bridge round-trip. Callers map every
 * `{ ok: false }` to 401, mirroring the backend `verify()`.
 */
export async function verifyLaunchToken(token: string, options: VerifySessionTokenOptions): Promise<boolean> {
  const result = await verifyLaunchTokenDetailed(token, options);
  return result.ok;
}

export async function verifyLaunchTokenDetailed(
  token: string,
  options: VerifySessionTokenOptions,
): Promise<{ ok: true; claims: LaunchTokenClaims } | { ok: false; reason: SessionTokenFailure }> {
  const envelope = await verifyTokenEnvelope(token, options);
  if (!envelope.ok) return envelope;

  const { payload } = envelope;
  if (payload.purpose !== "launch") {
    return { ok: false, reason: "wrong_purpose" };
  }

  const claims = readSessionClaims(payload);
  const { expected } = options;
  if (!claims || !bindingMatches(claims, expected)) {
    return { ok: false, reason: "binding_mismatch" };
  }
  return { ok: true, claims: { ...claims, ...readLaunchHints(payload) } };
}

/**
 * Shared envelope verification for both purposes: presence, secret shape,
 * algorithm pin, then signature + audience + issuer + expiry via jose.
 * Purpose and binding checks stay with the caller — the only thing that
 * differs between the bridge and launch verifiers.
 */
async function verifyTokenEnvelope(
  token: string,
  options: VerifySessionTokenOptions,
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; reason: SessionTokenFailure }> {
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

  try {
    const verified = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
      audience,
      issuer,
      clockTolerance: options.clockToleranceSeconds ?? SESSION_CLOCK_TOLERANCE_SECONDS,
    });
    return { ok: true, payload: verified.payload as Record<string, unknown> };
  } catch (error) {
    return { ok: false, reason: classifyJoseError(error) };
  }
}

function bindingMatches(claims: SessionTokenClaims, expected: SessionTokenBinding): boolean {
  return (
    claims.installationId === expected.installationId &&
    claims.vendorId === expected.vendorId &&
    claims.appSlug === expected.appSlug &&
    claims.appId === expected.appId
  );
}

/**
 * Launch-only hints off a verified payload. Tolerant by design (they steer
 * first paint, never auth): `store` is the integer p_id or null, `theme`
 * survives only as exactly `light` or `dark`.
 *
 * Boundary (deliberate, pinned both sides): this `store` claim is an INT,
 * while install-handoff p_ids are STRINGS per the handoff contract — never
 * accept a string here to "match" the handoff; a string claim nulls the
 * hint (session.test.ts) exactly as the backend pins int (AppUiKitTest).
 */
function readLaunchHints(payload: Record<string, unknown>): Pick<LaunchTokenClaims, "storePid" | "theme"> {
  const store = payload.store;
  const theme = payload.theme;
  return {
    storePid: typeof store === "number" && Number.isInteger(store) && store >= 0 ? store : null,
    theme: theme === "light" || theme === "dark" ? theme : null,
  };
}

/**
 * ROUTING HINT ONLY — the `installation_id` claim read WITHOUT verifying
 * anything, so a server can load the installation whose embed secret then
 * verifies the token with `verifySessionToken`. Never trust it on its
 * own: a caller that skips the verify has no authentication at all.
 * Null for anything that is not a decodable JWT carrying the claim.
 */
export function sessionTokenInstallationId(token: string): string | null {
  try {
    const claim = decodeJwt(token).installation_id;
    return typeof claim === "string" && claim.length > 0 ? claim : null;
  } catch {
    return null;
  }
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

/**
 * True for the purposes the bridge verifier accepts: absent (legacy
 * tokens) or "session". "launch" is the signed first-load token for the
 * launch exchange (`verifyLaunchToken`) only, so the bridge verifier
 * refuses it. Any other present value fails closed.
 */
export function isBridgePurpose(purpose: unknown): boolean {
  return purpose === undefined || purpose === null || purpose === "session";
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
