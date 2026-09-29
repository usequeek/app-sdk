import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { signQueekPayload } from "../src/signatures.js";

/**
 * Obviously-fake secret fixtures. Scanners flag `whsec_…`-shaped literals
 * as real webhook secrets, so NO test may contain a literal secret-shaped
 * value: every fixture is built at runtime here as `whsec_` + base64 of a
 * readable `fake-secret-…` word (decodes to English, never a key).
 */
export function fakeSecret(word: string): string {
  return `whsec_${Buffer.from(`fake-secret-${word}`, "utf8").toString("base64")}`;
}

/** Same idea for the `embsec_…` embed-secret shape. */
export function fakeEmbedSecret(word: string): string {
  return `embsec_${Buffer.from(`fake-embed-secret-${word}`, "utf8").toString("base64")}`;
}

/** Same idea for the `sk_test_…` API-key shape. */
export function fakeApiKey(word: string): string {
  return `sk_test_fake_${word}`;
}

/** A fake secret that is still unique per call (random tail, readable head). */
export function uniqueFakeSecret(word: string): string {
  return fakeSecret(`${word}-${randomBytes(4).toString("hex")}`);
}

/** Build Standard-Webhooks headers for a raw body, signed like Queek signs. */
export function signedHeaders(eventId: string, timestamp: number, rawBody: string, secret: string) {
  return {
    "webhook-id": eventId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signQueekPayload(eventId, timestamp, rawBody, secret),
  };
}

/**
 * Backend `AppInstallService::resyncPayload()` shape: the install-shaped
 * data under `type: app/resync`, plus the resync-only `secret_rotated`
 * flag. Settings carry the non-secret snapshot only.
 */
export function resyncBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "evt-resync-1",
    type: "app/resync",
    api_version: "v1",
    created_at: "2026-09-25T00:00:00+00:00",
    data: {
      installation: { id: "11111111-1111-1111-1111-111111111111", p_id: "inst_abc123" },
      app_id: "app-uuid-hello",
      store: {
        id: "22222222-2222-2222-2222-222222222222",
        p_id: "store_xyz",
        name: "Test Store",
        is_test: true,
      },
      api_base: "https://api.usequeek.com/api/v1/merchant",
      scopes: ["merchant-business_profile-read"],
      settings: { greeting: "resynced" },
      webhook_secret: uniqueFakeSecret("resync-webhook"),
      secret_rotated: true,
      webhook_url: "https://hello.apps.usequeek.com/webhooks",
      webhook_topics: ["orders/updated"],
      proxy_secret: uniqueFakeSecret("resync-proxy"),
      embed_secret: fakeEmbedSecret(`resync-${randomBytes(4).toString("hex")}`),
      ...overrides,
    },
  });
}

export function installBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "evt-install-1",
    type: "app/installed",
    api_version: "v1",
    created_at: "2026-09-24T00:00:00+00:00",
    data: {
      installation: { id: "11111111-1111-1111-1111-111111111111", p_id: "inst_abc123" },
      store: {
        id: "22222222-2222-2222-2222-222222222222",
        p_id: "store_xyz",
        name: "Test Store",
        is_test: true,
      },
      api_base: "https://api.usequeek.com/api/v1/merchant",
      // S1: no store-callable credential crosses the handoff (the app mints
      // installation tokens with its app key instead).
      scopes: ["merchant-business_profile-read"],
      settings: {},
      webhook_secret: uniqueFakeSecret("install-webhook"),
      proxy_secret: uniqueFakeSecret("install-proxy"),
      embed_secret: fakeEmbedSecret(`install-${randomBytes(4).toString("hex")}`),
      app_id: "app-uuid-hello",
      webhook_url: "https://hello.apps.usequeek.com/webhooks",
      webhook_topics: ["orders/updated"],
      ...overrides,
    },
  });
}

export async function postRaw(app: Hono, path: string, rawBody: string, headers: Record<string, string>) {
  return app.request(path, { method: "POST", headers, body: rawBody });
}
