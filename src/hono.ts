/**
 * Optional Hono integration for `@usequeek/app-sdk`.
 *
 * Import from `@usequeek/app-sdk/hono` (requires the optional `hono` peer):
 * `createInstallHandlers` and `createWebhookHandler` are thin wrappers over
 * the framework-agnostic core (`handleInstallRequest` /
 * `handleWebhookRequest` in the root entry) — same options objects, same
 * behaviour, same errors/status codes.
 */

import { Hono } from "hono";
import { handleInstallRequest, type InstallHandlerOptions } from "./install-handlers.js";
import { handleWebhookRequest, type WebhookHandlerOptions } from "./webhooks.js";

export type { InstallCallbacks, InstallHandlerOptions } from "./install-handlers.js";
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
