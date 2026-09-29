/**
 * Optional Hono integration for `@usequeek/app-sdk`.
 *
 * Import from `@usequeek/app-sdk/hono` (requires the optional `hono` peer):
 * `createInstallHandlers` and `createWebhookHandler` are thin wrappers
 * built ONLY on the layer-2 Web-standard handlers (`handleInstallRequest`
 * / `handleWebhookRequest` in the root entry) — same options objects, same
 * behaviour, same errors/status codes.
 */

import { Hono } from "hono";
import { handleInstallRequest, type InstallHandlerOptions } from "./install-handlers.js";
import { handleProxyRequest, type ProxyRequestOptions, type ProxyResponder } from "./proxy.js";
import { handleWebhookRequest, type WebhookHandlerOptions } from "./webhooks.js";

export type { InstallCallbacks, InstallHandlerOptions } from "./install-handlers.js";
export type { ProxyRequestOptions, ProxyResponder } from "./proxy.js";
export type {
  QueekWebhookEnvelope,
  SecretResolution,
  WebhookHandlerContext,
  WebhookHandlerFn,
  WebhookHandlerOptions,
} from "./webhooks.js";

/** Mount the signed install/uninstall/settings handoff (`POST /install`, `POST /uninstall`, `POST /settings`). */
export function createInstallHandlers(options: InstallHandlerOptions): Hono {
  const app = new Hono();
  app.post("/install", (c) => handleInstallRequest(c.req.raw, options));
  app.post("/uninstall", (c) => handleInstallRequest(c.req.raw, options));
  app.post("/settings", (c) => handleInstallRequest(c.req.raw, options));
  return app;
}

/** Mount the signed topic-delivery receiver (`POST /`). */
export function createWebhookHandler(options: WebhookHandlerOptions): Hono {
  const app = new Hono();
  app.post("/", (c) => handleWebhookRequest(c.req.raw, options));
  return app;
}

/**
 * Mount the signed app-proxy reader (`GET`, phase 1 is read-only by binding
 * rule) — a thin wrapper built ONLY on the layer-2 Web-standard handler
 * (`handleProxyRequest` in the root entry). Mount it where the proxy lives
 * (`app.route("/proxy", createProxyHandler(...))`); `options.path` stays
 * the Queek-side canonical path (`/apps/<subpath>/<rest>`) the backend
 * signed, and `onVerified` owns the shopper-facing body.
 */
export function createProxyHandler(options: ProxyRequestOptions & { onVerified: ProxyResponder }): Hono {
  const { onVerified, ...requestOptions } = options;
  const app = new Hono();
  app.get("*", (c) => handleProxyRequest(c.req.raw, requestOptions, onVerified));
  return app;
}
