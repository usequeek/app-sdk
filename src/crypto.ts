import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope encryption for secrets at rest (installation tokens,
 * webhook/proxy/embed secrets and settings). One random 96-bit IV per value; the stored string is
 * `v1.<base64 iv>.<base64 ciphertext+tag>`.
 *
 * The 32-byte data key comes from the environment (`APP_ENCRYPTION_KEY`, base64
 * or hex of 32 bytes) and is parsed by `parseStoreKey()`. The key itself is
 * NEVER logged — only its 8-char fingerprint (first bytes, hex) may appear in
 * logs to prove which key a ciphertext belongs to.
 */

const ENVELOPE_VERSION = "v1";
const IV_BYTES = 12;

/**
 * Parse `APP_ENCRYPTION_KEY` (base64 or hex of 32 bytes, or a raw 32-character
 * string) into the AES-256 key. Prefer random bytes: a raw string key is only
 * as strong as the text you chose. Throws with a fix when the value is
 * missing or the wrong length.
 *
 * @example
 * const key = parseStoreKey(process.env.APP_ENCRYPTION_KEY);
 */
export function parseStoreKey(raw: string | undefined): Buffer {
  if (!raw || raw.trim() === "") {
    throw new Error(
      "Missing store encryption key: set APP_ENCRYPTION_KEY to base64 or hex of 32 random bytes (`queek app dev` mints one into .queek/.env.local on first run; otherwise generate with node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\" and keep it in your secrets manager — key + DB loss = working data lost).",
    );
  }
  const value = raw.trim();
  const candidates: Buffer[] = [];
  // Base64 only when it looks like base64 (length multiple of 4); a raw
  // 32-char passphrase must NOT be misread as base64.
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0) {
    try {
      candidates.push(Buffer.from(value, "base64"));
    } catch {
      // fall through to hex/utf8
    }
  }
  if (/^[0-9a-fA-F]+$/.test(value)) {
    try {
      candidates.push(Buffer.from(value, "hex"));
    } catch {
      // fall through
    }
  }
  candidates.push(Buffer.from(value, "utf8"));
  const key = candidates.find((candidate) => candidate.length === 32);
  if (!key) {
    throw new Error(
      "Invalid APP_ENCRYPTION_KEY: it must decode to exactly 32 bytes (base64 or hex). Generate one with `node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\"`.",
    );
  }
  return key;
}

/** Non-secret fingerprint for logs (first 4 bytes, hex). Reveals nothing usable. */
export function storeKeyFingerprint(key: Buffer): string {
  return key.subarray(0, 4).toString("hex");
}

/** Encrypt `plaintext` with AES-256-GCM into a `v1.<iv>.<ciphertext+tag>` envelope. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  if (key.length !== 32)
    throw new Error(
      `Encryption key must be exactly 32 bytes, got ${key.length}. Build it with parseStoreKey().`,
    );
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENVELOPE_VERSION, iv.toString("base64"), Buffer.concat([ciphertext, tag]).toString("base64")].join(
    ".",
  );
}

/** Decrypt an envelope made by {@link encryptSecret}. Throws a plain `Error` (with `cause`) on a wrong key or altered value. */
export function decryptSecret(envelope: string, key: Buffer): string {
  if (key.length !== 32)
    throw new Error(
      `Encryption key must be exactly 32 bytes, got ${key.length}. Build it with parseStoreKey().`,
    );
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error(
      "Unrecognized secret envelope: expected `v1.<iv>.<ciphertext>`. The stored value was not written by this SDK or was truncated.",
    );
  }
  const iv = Buffer.from(parts[1] as string, "base64");
  const raw = Buffer.from(parts[2] as string, "base64");
  if (iv.length !== IV_BYTES || raw.length < 17) {
    throw new Error(
      "Corrupt secret envelope: the IV or ciphertext has the wrong length. Restore the row from a backup.",
    );
  }
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(0, raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (cause) {
    throw new Error(
      "Could not decrypt a stored secret: it was written with a different APP_ENCRYPTION_KEY, or the value was changed. Restore the original key; without it the secret cannot be recovered.",
      { cause },
    );
  }
}
