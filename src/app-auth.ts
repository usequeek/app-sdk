import { createPrivateKey, createSign } from "node:crypto";

/**
 * The app credential (S1, SDK 0.2.0): ONE asymmetric RS256 key per app.
 * Queek holds the PUBLIC keys (`apps.public_keys`, kid-capped); the app
 * holds the PRIVATE key in `APP_PRIVATE_KEY` and signs short-lived app
 * JWTs that mint per-installation tokens (`acquireToken()`).
 *
 * Wire contract (BINDING for B2 and S1): every call under `/api/v1/apps`
 * carries `Authorization: Bearer <app JWT>` (RS256, header `kid`, claims
 * `iss` = app slug, `iat`, `exp`, `exp − iat` ≤ 600 s). `node:crypto` only
 * — no new dependency. The JWT and the private key are NEVER logged (the
 * logger redacts `Bearer …` values; signers below never emit them).
 */

// ---------------------------------------------------------------------------
// Wire-contract error codes. Each code the SDK reacts to lives in EXACTLY
// one constant here, so a backend rename is a one-line change the parallel
// B1/B2 build must confirm.
// ---------------------------------------------------------------------------

/** 401 on an app-credential call: bad/expired JWT or unknown kid. Fatal for the app. */
export const INVALID_CLIENT_CODE = "invalid_client";
/**
 * 403 on an app-credential call: the app is disabled or its token epoch was
 * bumped by `app:revoke-tokens` (kill switch). Confirmed against B1
 * (`ApiError::APP_TOKEN_REVOKED`, returned in both cases); matched in
 * exactly one place (`isAppTokenRevoked`).
 */
export const APP_TOKEN_REVOKED_CODE = "app_token_revoked";
/** 404 on an installation-scoped app call: purge that installation locally. */
export const APP_INSTALLATION_GONE_CODE = "app_installation_gone";
/**
 * 409 on an installation-scoped app call: the installation is PENDING
 * (not yet active). Retry later with backoff — NEVER purge, NEVER halt.
 * `GET installations` lists active installations only, so a pending row is
 * absent from the list: resync's purge-absent step must keep local rows
 * the app knows (via a 409) are pending.
 */
export const APP_INSTALLATION_PENDING_CODE = "app_installation_pending";
/**
 * 429 on a per-installation resync: the ≤1/hour rotation COOLDOWN. Skip
 * that installation (recorded, no retry loop). Any OTHER resync 429 is the
 * per-app bucket (`too_many_requests`): back off on `Retry-After`
 * (jittered) and retry — never recorded as a cooldown skip.
 */
export const RESYNC_COOLDOWN_CODE = "resync_cooldown";
/** 429 everywhere: honor `Retry-After`, jittered. */
export const TOO_MANY_REQUESTS_CODE = "too_many_requests";
/**
 * 403 on a merchant call: the cached installation token was minted for an
 * older grant (missing scope). The grant changed server-side — drop the
 * cached token, re-mint once, retry once.
 */
export const INSUFFICIENT_SCOPE_CODE = "insufficient_scope";

/** True when a Queek error code is the kill-switch/disabled refusal. */
export function isAppTokenRevoked(code: string | undefined): boolean {
  return code === APP_TOKEN_REVOKED_CODE;
}

/** True when a Queek error code is the fatal app-credential refusal. */
export function isInvalidClient(code: string | undefined): boolean {
  return code === INVALID_CLIENT_CODE;
}

/** True when a Queek error code means the installation is gone server-side. */
export function isInstallationGone(code: string | undefined): boolean {
  return code === APP_INSTALLATION_GONE_CODE;
}

/** True when a Queek error code means the installation is pending (409: retry later, never purge). */
export function isInstallationPending(code: string | undefined): boolean {
  return code === APP_INSTALLATION_PENDING_CODE;
}

/** True when a resync 429 code is the per-installation rotation cooldown (skip, recorded). */
export function isResyncCooldown(code: string | undefined): boolean {
  return code === RESYNC_COOLDOWN_CODE;
}

/**
 * Merchant-API token-refusal codes (rev 7): a token in one of these states
 * is dead — drop it, re-mint once, retry once. `api_key_revoked` covers the
 * uninstalled store, the removed kid, and the replaced K-slot; the re-mint
 * then answers 404 `app_installation_gone` (purge) or 401 `invalid_client`
 * (halt) where applicable. Every OTHER merchant 403 (plan, mode)
 * propagates to the caller without a mint.
 */
export const API_KEY_REVOKED_CODE = "api_key_revoked";
export const API_KEY_EXPIRED_CODE = "api_key_expired";
export const INVALID_CLIENT_KEY_CODE = "invalid_client_key";

/**
 * True when a merchant-API refusal means the presented token is dead: any
 * 401, or a 403 with a revoked/expired-key code. `app_token_revoked` is
 * deliberately NOT here — that is the app-wide kill switch (drop all +
 * halt), not a single dead token.
 */
export function isTokenRefusal(status: number, code: string | undefined): boolean {
  if (status === 401) return true;
  return (
    status === 403 &&
    (code === API_KEY_REVOKED_CODE || code === API_KEY_EXPIRED_CODE || code === INVALID_CLIENT_KEY_CODE)
  );
}

/** True when a merchant-API 403 means the cached token predates a grant change. */
export function isInsufficientScope(status: number, code: string | undefined): boolean {
  return status === 403 && code === INSUFFICIENT_SCOPE_CODE;
}

// ---------------------------------------------------------------------------
// Timing bounds (all in the open, all injectable in tests).
// ---------------------------------------------------------------------------

/** App-JWT `iat` is backdated this far (clock skew, GitHub's recommendation). */
export const APP_JWT_SKEW_SECONDS = 60;
/** App-JWT lifetime: `exp = iat + 540`, so `exp − iat` (540 s) stays ≤ the 600 s wire bound. */
export const APP_JWT_TTL_SECONDS = 540;
/** A cached installation token counts as valid only while its expiry is more than this far away. */
export const TOKEN_VALIDITY_SKEW_SECONDS = 300;
/** Mint attempts per `acquireToken` before surfacing a 429/5xx (1 initial + retries). */
export const MAX_MINT_ATTEMPTS = 3;
/** 5xx backoff base (doubles per attempt); every sleep also carries uniform jitter (see below). */
export const MINT_BACKOFF_BASE_MS = 250;
/** 5xx backoff ceiling (a 429 `Retry-After` may exceed it — the server's word wins). */
export const MINT_BACKOFF_MAX_MS = 5_000;
/** Uniform jitter added to every mint/resync backoff sleep (0–1000 ms). */
export const RETRY_JITTER_MAX_MS = 1_000;

// ---------------------------------------------------------------------------
// Credential.
// ---------------------------------------------------------------------------

/** Thrown when `APP_PRIVATE_KEY`/`APP_KEY_ID`/slug fail validation — before any fetch. */
export class InvalidAppCredentialError extends Error {
  readonly code = "invalid_app_credential";

  constructor(message: string) {
    super(message);
    this.name = "InvalidAppCredentialError";
  }
}

/**
 * Thrown (and cached in-process) when Queek refuses the app itself:
 * `invalid_client` (bad/unknown key — fatal until the key is fixed) or the
 * kill-switch 403 (disabled/epoch-revoked — fatal until the app is
 * re-enabled). Minting STOPS: no retry loop. Clears on process restart;
 * call `resumeMinting()` to clear it sooner (tests, or an operator who
 * just re-enabled the app).
 */
export class AppMintHaltedError extends Error {
  readonly code = "app_mint_halted";
  readonly reason: typeof INVALID_CLIENT_CODE | typeof APP_TOKEN_REVOKED_CODE;

  constructor(reason: AppMintHaltedError["reason"], detail: string) {
    super(`Minting halted (${reason}): ${detail}`);
    this.name = "AppMintHaltedError";
    this.reason = reason;
  }
}

/** Thrown when no installation row exists locally for an id. */
export class UnknownInstallationError extends Error {
  readonly code = "unknown_installation";

  constructor(installationId: string) {
    super(`Unknown installation ${installationId}: no local row (resync or reinstall first).`);
    this.name = "UnknownInstallationError";
  }
}

export interface AppCredential {
  /** `iss`: the app slug (as registered with `app:register`). */
  appSlug: string;
  /** `kid`: which of the app's public keys Queek verifies against (`APP_KEY_ID`). */
  keyId: string;
  /** PEM-encoded PKCS#8 / PKCS#1 RSA private key (`APP_PRIVATE_KEY`). Memory only, never logged. */
  privateKeyPem: string;
}

export interface AppCredentialOptions {
  appSlug?: string;
  keyId?: string;
  privateKeyPem?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Accepted `APP_PRIVATE_KEY` forms (env files are one line per variable):
 * raw PEM text, one-line PEM with literal `\n` escapes, or base64 of the
 * full PEM text (one line, no wrapping — what the Developer page shows).
 */
export const APP_PRIVATE_KEY_FORMS =
  "raw PEM text, one-line PEM with literal \\n escapes, or base64 of the PEM text";

/**
 * Normalize an `APP_PRIVATE_KEY` value to PEM text. Detection: a trimmed
 * value starting with `-----BEGIN` is PEM (literal `\n` unescaped first);
 * anything else is base64-decoded and must decode to `-----BEGIN…`.
 * Never echoes the value.
 */
export function decodePrivateKeyInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("-----BEGIN")) {
    return trimmed.replace(/\\n/g, "\n").trim();
  }
  const decoded = Buffer.from(trimmed, "base64").toString("utf8");
  if (!decoded.trimStart().startsWith("-----BEGIN")) {
    throw new InvalidAppCredentialError(
      `Invalid APP_PRIVATE_KEY: not a PEM and not base64 of a PEM. Accepted forms: ${APP_PRIVATE_KEY_FORMS}.`,
    );
  }
  return decoded.trim();
}

/**
 * Load the app credential: explicit options win, otherwise `APP_SLUG`,
 * `APP_KEY_ID`, `APP_PRIVATE_KEY` from env. The key must parse as an RSA
 * private key here, once, so a broken key fails at boot — never mid-mint.
 * Throws `InvalidAppCredentialError` before any fetch.
 */
export function loadAppCredential(options: AppCredentialOptions = {}): AppCredential {
  const env = options.env ?? process.env;
  const appSlug = (options.appSlug ?? env.APP_SLUG ?? "").trim();
  if (appSlug === "") {
    throw new InvalidAppCredentialError(
      "Missing app slug for `iss`: pass appSlug or set APP_SLUG to the slug registered with Queek.",
    );
  }
  const keyId = (options.keyId ?? env.APP_KEY_ID ?? "").trim();
  if (keyId === "") {
    throw new InvalidAppCredentialError(
      "Missing APP_KEY_ID: set it to the kid registered with Queek (`php artisan app:register --public-key=…`).",
    );
  }
  const privateKeyInput = (options.privateKeyPem ?? env.APP_PRIVATE_KEY ?? "").trim();
  if (privateKeyInput === "") {
    throw new InvalidAppCredentialError(
      `Missing APP_PRIVATE_KEY: set it to base64 of the app's RSA private key PEM (one line). Accepted forms: ${APP_PRIVATE_KEY_FORMS}.`,
    );
  }
  const privateKeyPem = decodePrivateKeyInput(privateKeyInput);
  try {
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== "rsa") {
      throw new InvalidAppCredentialError(
        `Invalid APP_PRIVATE_KEY: asymmetric key type is ${key.asymmetricKeyType ?? "unknown"}, need rsa.`,
      );
    }
  } catch (error) {
    if (error instanceof InvalidAppCredentialError) throw error;
    throw new InvalidAppCredentialError(
      `Invalid APP_PRIVATE_KEY: not a parseable PEM private key (${error instanceof Error ? error.message : "undecodable"}). Accepted forms: ${APP_PRIVATE_KEY_FORMS}.`,
    );
  }
  // The PEM stays in this object only; callers must never log it (see
  // `signAppJwt`: the only consumer, and it never emits the key).
  return { appSlug, keyId, privateKeyPem };
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input as string).toString("base64url");
}

export interface SignAppJwtOptions {
  credential: AppCredential;
  /** Seconds since epoch. Defaults to `Date.now() / 1000` (injectable in tests). */
  nowSeconds?: number;
}

/**
 * Sign an app JWT (RS256, `node:crypto` only): header `{alg RS256, kid}`,
 * claims `{iss = app slug, iat = now − 60 s, exp = iat + 540 s}` — the
 * `exp − iat` window (540 s) stays under the 600 s wire bound. Returns the
 * compact JWT; NEVER logs it or the private key.
 */
export function signAppJwt(options: SignAppJwtOptions): string {
  const now = Math.floor(options.nowSeconds ?? Date.now() / 1000);
  const iat = now - APP_JWT_SKEW_SECONDS;
  const exp = iat + APP_JWT_TTL_SECONDS;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: options.credential.keyId }));
  const payload = base64Url(JSON.stringify({ iss: options.credential.appSlug, iat, exp }));
  const signingInput = `${header}.${payload}`;
  let signature: Buffer;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput, "utf8");
    signature = signer.sign(options.credential.privateKeyPem);
  } catch (error) {
    throw new InvalidAppCredentialError(
      `Could not sign the app JWT (is APP_PRIVATE_KEY the matching RSA key for kid ${JSON.stringify(options.credential.keyId)}?): ${error instanceof Error ? error.message : "signing failed"}`,
    );
  }
  return `${signingInput}.${signature.toString("base64url")}`;
}
