import { describe, expect, it } from "vitest";
import { signQueekPayload, verifyQueekSignature } from "../src/signatures.js";

/**
 * Byte-exact vectors against Queek's `App\Services\Webhooks\WebhookSigner`.
 * Each `expected` below was computed by the BACKEND's signer
 * (`WebhookSigner::sign()` via `php -r` on queek_backend @ b805eba2) and is
 * pinned here — if the two sides ever disagree, this test goes red.
 *
 * Signed content on both sides: `{id}.{timestamp}.{raw body}`, HMAC-SHA256
 * keyed by the base64-DECODED `whsec_…` bytes, header `v1,<base64 mac>`.
 */
const VECTORS = [
  {
    id: "evt_test_001",
    timestamp: 1758685600,
    body: '{"id":"evt_test_001","type":"app/installed","data":{"a":1}}',
    secret: "whsec_MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIz",
    expected: "v1,hDLM0A3g+kd/wMQ2ZeHNh11krQggBoj+vh9bP0VDeuM=",
  },
  {
    id: "msg_hello",
    timestamp: 1758685601,
    body: "{}",
    secret: "whsec_MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIz",
    expected: "v1,qoOK9EloheQJyEJPdee6fNBY+tOpfPB7quVdMgCVj3A=",
  },
  {
    id: "evt_empty",
    timestamp: 0,
    body: "",
    secret: "whsec_dGVzdHNlY3JldGtleXRlc3RzZWNyZXRr",
    expected: "v1,+XBXmLpgaqmIGzrInMtBaVHqpOjp/43ojUxBJMoSenE=",
  },
] as const;

describe("byte-exact vectors from WebhookSigner", () => {
  for (const vector of VECTORS) {
    it(`signs ${vector.id} exactly like the backend`, () => {
      expect(signQueekPayload(vector.id, vector.timestamp, vector.body, vector.secret)).toBe(vector.expected);
    });

    it(`verifies ${vector.id} (freshness skipped: the vector is a fixed instant)`, () => {
      expect(
        verifyQueekSignature(
          {
            id: vector.id,
            timestamp: String(vector.timestamp),
            body: vector.body,
            signatureHeader: vector.expected,
            secret: vector.secret,
          },
          { skipFreshnessCheck: true },
        ),
      ).toBe(true);
    });
  }
});

describe("verification semantics (mirroring WebhookSigner::verify)", () => {
  const now = 1758685600;
  const input = {
    id: "evt_live",
    timestamp: String(now),
    body: '{"a":1}',
    secret: "whsec_MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIz",
  };
  const header = signQueekPayload(input.id, now, input.body, input.secret);

  it("accepts any one signature in a space-delimited rotation header", () => {
    const other = signQueekPayload(input.id, now, input.body, "whsec_b3RoZXJzZWNyZXR2YWx1ZXNlY3JldA==");
    expect(
      verifyQueekSignature({ ...input, signatureHeader: `${other} ${header}` }, { nowSeconds: now }),
    ).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(
      verifyQueekSignature(
        { ...input, signatureHeader: header, secret: "whsec_d3JvbmdzZWNyZXR3cm9uZ3NlY3JldHhy" },
        { nowSeconds: now },
      ),
    ).toBe(false);
  });

  it("rejects re-serialised JSON: the MAC covers the RAW bytes", () => {
    expect(
      verifyQueekSignature({ ...input, signatureHeader: header, body: '{"a": 1}' }, { nowSeconds: now }),
    ).toBe(false);
  });

  it("rejects a tampered id (the id is inside the MAC)", () => {
    expect(
      verifyQueekSignature({ ...input, signatureHeader: header, id: "evt_other" }, { nowSeconds: now }),
    ).toBe(false);
  });

  it("rejects stale timestamps", () => {
    expect(verifyQueekSignature({ ...input, signatureHeader: header }, { nowSeconds: now + 301 })).toBe(
      false,
    );
  });

  it("rejects missing headers", () => {
    expect(verifyQueekSignature({ ...input, signatureHeader: "" }, { nowSeconds: now })).toBe(false);
  });
});
