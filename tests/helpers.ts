import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { signQueekPayload } from "../src/signatures.js";

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
      webhook_secret: `whsec_${randomBytes(24).toString("base64")}`,
      secret_rotated: true,
      webhook_url: "https://hello.apps.usequeek.com/webhooks",
      webhook_topics: ["orders/updated"],
      proxy_secret: `whsec_${randomBytes(24).toString("base64")}`,
      embed_secret: `embsec_${randomBytes(24).toString("base64")}`,
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
      webhook_secret: `whsec_${randomBytes(24).toString("base64")}`,
      proxy_secret: `whsec_${randomBytes(24).toString("base64")}`,
      embed_secret: `embsec_${randomBytes(24).toString("base64")}`,
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
