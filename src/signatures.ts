import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Standard Webhooks verification, byte-for-byte compatible with Queek's
 * `App\Services\Webhooks\WebhookSigner` (queek_backend).
 *
 * Signed content: `{id}.{timestamp}.{body}` where `body` is the RAW request
 * bytes. Re-serialising JSON before verifying breaks the MAC — verify first,
 * parse second.
 *
 * The MAC key is the DECODED bytes of the `whsec_<base64>` secret, not the
 * printable string. A secret without the prefix (or with undecodable base64)
 * falls back to the raw string, exactly like the backend's `keyFor()`.
 *
 * Header names: `webhook-id`, `webhook-timestamp`, `webhook-signature`.
 * The signature header may carry several space-delimited `v1,<base64>`
 * signatures (rotation grace window): ANY match verifies.
 */

export const WEBHOOK_ID_HEADER = "webhook-id";
export const WEBHOOK_TIMESTAMP_HEADER = "webhook-timestamp";
export const WEBHOOK_SIGNATURE_HEADER = "webhook-signature";
export const SECRET_PREFIX = "whsec_";

/** Maximum age of a delivery before it is rejected as stale (5 minutes, the Standard Webhooks default). */
export const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

export interface SignatureInput {
  /** Value of the `webhook-id` header. */
  id: string;
  /** Value of the `webhook-timestamp` header (unix seconds, as sent). */
  timestamp: string;
  /** Raw request body bytes, untouched. */
  body: string;
  /** Value of the `webhook-signature` header (one or more space-delimited signatures). */
  signatureHeader: string;
  /** The endpoint/app `whsec_…` secret. */
  secret: string;
}

export interface VerifyOptions {
  /** Unix seconds to judge freshness against (defaults to now). Exposed for tests. */
  nowSeconds?: number;
  /** Allowed clock skew in seconds (defaults to MAX_TIMESTAMP_SKEW_SECONDS). */
  maxSkewSeconds?: number;
  /** Skip the freshness check (NOT recommended; exposed for replaying stored fixtures). */
  skipFreshnessCheck?: boolean;
}

export function secretKeyBytes(secret: string): Buffer {
  const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  try {
    const decoded = Buffer.from(encoded, "base64");
    // Round-trip guard: the backend uses `base64_decode($encoded, true) ?: $secret`,
    // i.e. undecodable input falls back to the raw secret string.
    if (decoded.length > 0 && decoded.toString("base64").replace(/=+$/, "") === encoded.replace(/=+$/, "")) {
      return decoded;
    }
    return Buffer.from(secret, "utf8");
  } catch {
    return Buffer.from(secret, "utf8");
  }
}

/** One `v1,<base64>` signature for one secret — mirrors `WebhookSigner::sign()`. */
export function signQueekPayload(
  eventId: string,
  timestamp: number | string,
  body: string,
  secret: string,
): string {
  const mac = createHmac("sha256", secretKeyBytes(secret))
    .update(`${eventId}.${timestamp}.${body}`, "utf8")
    .digest();
  return `v1,${mac.toString("base64")}`;
}

/** Failure reason when verification rejects a delivery. */
export type SignatureFailure = "missing_headers" | "stale_timestamp" | "signature_mismatch";

export function verifyQueekSignature(input: SignatureInput, options: VerifyOptions = {}): boolean {
  return verifyQueekSignatureDetailed(input, options).ok;
}

export function verifyQueekSignatureDetailed(
  input: SignatureInput,
  options: VerifyOptions = {},
): { ok: true } | { ok: false; reason: SignatureFailure } {
  const { id, timestamp, body, signatureHeader, secret } = input;
  if (!id || !timestamp || !signatureHeader || !secret) {
    return { ok: false, reason: "missing_headers" };
  }

  if (!options.skipFreshnessCheck) {
    const ts = Number(timestamp);
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const maxSkew = options.maxSkewSeconds ?? MAX_TIMESTAMP_SKEW_SECONDS;
    if (!Number.isFinite(ts) || Math.abs(now - ts) > maxSkew) {
      return { ok: false, reason: "stale_timestamp" };
    }
  }

  const expected = signQueekPayload(id, timestamp, body, secret);
  const expectedBuf = Buffer.from(expected, "utf8");
  for (const candidate of signatureHeader.trim().split(/\s+/)) {
    if (candidate === "") continue;
    const candidateBuf = Buffer.from(candidate, "utf8");
    if (candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "signature_mismatch" };
}
