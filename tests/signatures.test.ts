import { describe, expect, it } from "vitest";
import { signQueekPayload, verifyQueekSignature } from "../src/signatures.js";
import { fakeSecret } from "./helpers.js";

/**
 * Byte-exact vectors against Queek's `App\Services\Webhooks\WebhookSigner`.
 * Each `expected` below was computed with an INDEPENDENT HMAC-SHA256
 * implementation (python `hmac`, key = base64-decoded `whsec_…` bytes) and
 * is pinned here — if the two sides ever disagree, this test goes red.
 * Secrets are runtime-built fakes (`fakeSecret`), never literals.
 *
 * Signed content on both sides: `{id}.{timestamp}.{raw body}`, HMAC-SHA256
 * keyed by the base64-DECODED `whsec_…` bytes, header `v1,<base64 mac>`.
 */
const VECTORS = [
  {
    id: "evt_test_001",
    timestamp: 1758685600,
    body: '{"id":"evt_test_001","type":"app/installed","data":{"a":1}}',
    word: "webhook-vector-a",
    expected: "v1,Ijrl84IMy4X7lOcxYgaM9ztn/n0PBfV3BvJFhpfByN0=",
  },
  {
    id: "msg_hello",
    timestamp: 1758685601,
    body: "{}",
    word: "webhook-vector-a",
    expected: "v1,TNE7v2wuIM+qUzXv3OuempF0LIXDVe9JteL7a+dNqBM=",
  },
  {
    id: "evt_empty",
    timestamp: 0,
    body: "",
    word: "webhook-test-key",
    expected: "v1,/UThieRBLDSUGJGof0dmEWAAitzWki/bMa+6n+lFpOE=",
  },
] as const;

describe("byte-exact vectors from WebhookSigner", () => {
  for (const vector of VECTORS) {
    const secret = fakeSecret(vector.word);
    it(`signs ${vector.id} exactly like the backend`, () => {
      expect(signQueekPayload(vector.id, vector.timestamp, vector.body, secret)).toBe(vector.expected);
    });

    it(`verifies ${vector.id} (freshness skipped: the vector is a fixed instant)`, () => {
      expect(
        verifyQueekSignature(
          {
            id: vector.id,
            timestamp: String(vector.timestamp),
            body: vector.body,
            signatureHeader: vector.expected,
            secret,
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
    secret: fakeSecret("live"),
  };
  const header = signQueekPayload(input.id, now, input.body, input.secret);

  it("accepts any one signature in a space-delimited rotation header", () => {
    const other = signQueekPayload(input.id, now, input.body, fakeSecret("other"));
    expect(
      verifyQueekSignature({ ...input, signatureHeader: `${other} ${header}` }, { nowSeconds: now }),
    ).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(
      verifyQueekSignature(
        { ...input, signatureHeader: header, secret: fakeSecret("wrong") },
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
