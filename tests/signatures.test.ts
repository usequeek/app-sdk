import { describe, expect, it } from "vitest";
import { signQueekPayload, verifyQueekSignature } from "../src/signatures.js";
import { fakeSecret } from "./helpers.js";

/**
 * Byte-exact vectors for Queek's webhook signature format.
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

describe("byte-exact signature vectors", () => {
  for (const vector of VECTORS) {
    const secret = fakeSecret(vector.word);
    it(`signs ${vector.id} exactly like Queek`, () => {
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

describe("verification semantics", () => {
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

describe("timestamp freshness", () => {
  const secret = fakeSecret("freshness");
  const NOW = 1758685600;
  const verifyAt = (timestamp: string) =>
    verifyQueekSignature(
      {
        id: "evt_1",
        timestamp,
        body: "{}",
        signatureHeader: signQueekPayload("evt_1", timestamp, "{}", secret),
        secret,
      },
      { nowSeconds: NOW },
    );

  it("accepts a plain integer inside the window, early or late", () => {
    expect(verifyAt(String(NOW))).toBe(true);
    expect(verifyAt(String(NOW - 299))).toBe(true);
    expect(verifyAt(String(NOW + 299))).toBe(true);
  });

  it("rejects outside the window, and any timestamp that is not a plain integer", () => {
    expect(verifyAt(String(NOW - 301))).toBe(false);
    expect(verifyAt(String(NOW + 301))).toBe(false);
    for (const odd of ["1e3", "0x10", "1758685600.5", " 1758685600", "-1758685600", "NaN"]) {
      expect(verifyAt(odd)).toBe(false);
    }
  });
});
