import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope encryption for secrets at rest (installation api_key
 * and webhook_secret). One random 96-bit IV per value; the stored string is
 * `v1.<base64 iv>.<base64 ciphertext+tag>`.
 *
 * The 32-byte data key comes from the environment (`QUEEK_STORE_KEY`, base64
 * or hex of 32 bytes) and is parsed by `parseStoreKey()`. The key itself is
 * NEVER logged — only its 8-char fingerprint (first bytes, hex) may appear in
 * logs to prove which key a ciphertext belongs to.
 */

const ENVELOPE_VERSION = "v1";
const IV_BYTES = 12;

export function parseStoreKey(raw: string | undefined): Buffer {
  if (!raw || raw.trim() === "") {
    throw new Error("Missing store encryption key: set QUEEK_STORE_KEY to base64 or hex of 32 random bytes.");
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
    throw new Error("Invalid QUEEK_STORE_KEY: must decode to exactly 32 bytes (base64 or hex).");
  }
  return key;
}

/** Non-secret fingerprint for logs (first 4 bytes, hex). Reveals nothing usable. */
export function storeKeyFingerprint(key: Buffer): string {
  return key.subarray(0, 4).toString("hex");
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes.");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENVELOPE_VERSION, iv.toString("base64"), Buffer.concat([ciphertext, tag]).toString("base64")].join(
    ".",
  );
}

export function decryptSecret(envelope: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes.");
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error("Unrecognized secret envelope (expected v1.<iv>.<ciphertext>).");
  }
  const iv = Buffer.from(parts[1] as string, "base64");
  const raw = Buffer.from(parts[2] as string, "base64");
  if (iv.length !== IV_BYTES || raw.length < 17) {
    throw new Error("Corrupt secret envelope.");
  }
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(0, raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
