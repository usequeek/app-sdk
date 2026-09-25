import { Hono } from "hono";
import {
  type HandoffEnvelopeAny,
  INSTALL_EVENT,
  type InstallData,
  type InstallEnvelope,
  SETTINGS_EVENT,
  type SettingsEnvelope,
  UNINSTALL_EVENT,
  type UninstallEnvelope,
} from "./handoff.js";
import {
  MAX_TIMESTAMP_SKEW_SECONDS,
  verifyQueekSignatureDetailed,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "./signatures.js";
import type { InstallationRecord, InstallationStore } from "./store.js";

/**
 * Hono handlers for Queek's signed server-to-server handoff
 * (`AppInstallService::deliver()` in queek_backend).
 *
 * Every handoff — install, uninstall, settings — carries the Standard
 * Webhooks headers signed with the APP signing secret (`whsec_…`, minted
 * once at `app:register`). The app answers 2xx only after the installation
 * is durably stored; anything else makes Queek revoke the just-minted key
 * and mark the install failed (retry = a fresh install).
 *
 * Order per request: verify signature (freshness included) → parse the
 * typed payload → atomically claim the header `webhook-id` (a claimed id
 * answers 409: exactly one same-id delivery runs the callback) → run the
 * callback → 2xx. A callback that throws (e.g. the store write failed)
 * RELEASES the claim and answers non-2xx, so a Queek retry can still land.
 * The claim and the check are the SAME header id — never the body id.
 */

export interface InstallCallbacks {
  /** Defaults to persisting the installation (encrypted) in `store`. */
  onInstall?: (envelope: InstallEnvelope) => Promise<void>;
  /** Defaults to deleting the installation from `store`. */
  onUninstall?: (envelope: UninstallEnvelope) => Promise<void>;
  /** Defaults to merging the new settings into the stored installation. */
  onSettings?: (envelope: SettingsEnvelope) => Promise<void>;
}

export interface InstallHandlerOptions extends InstallCallbacks {
  /** The app signing secret (`whsec_…`) from Queek registration. */
  appSecret: string;
  store: InstallationStore;
  nowSeconds?: number;
  maxSkewSeconds?: number;
}

/**
 * Build the storable installation record from install `data`. Timestamps
 * default to now. Exported so apps with a custom `onInstall` (e.g. to
 * proof-call the Merchant API before answering 2xx) persist exactly what
 * the default handler would — never a divergent mapping.
 */
export function buildInstallationRecord(
  data: InstallData,
  nowIso: string = new Date().toISOString(),
): InstallationRecord {
  return installationRecordFromInstall(data, nowIso);
}

function installationRecordFromInstall(data: InstallData, nowIso: string): InstallationRecord {
  return {
    installationId: data.installation.id,
    installationPid: data.installation.p_id,
    vendorId: data.store.id,
    storePid: data.store.p_id,
    storeName: data.store.name,
    apiBase: data.api_base,
    // No credential crosses the handoff (S1): a fresh row caches no token
    // (the first call mints one); see `saveResyncedInstallation` for the
    // existing-row path, which keeps the cached token.
    token: null,
    tokenExpiresAt: null,
    tokenKid: null,
    // A handoff (install or resync redelivery) proves Queek holds the
    // installation: fresh rows start unflagged, and a redelivery for an
    // existing row clears a stale pending mark (seen active).
    pending: false,
    scopes: data.scopes,
    settings: data.settings,
    webhookSecret: data.webhook_secret,
    webhookUrl: data.webhook_url,
    webhookTopics: data.webhook_topics,
    installedAt: nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Merge a re-delivered install envelope (resync) into an existing row:
 * refresh the ref fields, scopes, settings and webhook secret, but keep
 * the original `installedAt` and the cached installation token (a secret
 * rotation does not invalidate minted tokens; `resyncFromQueek` drops
 * tokens explicitly when it wants fresh ones).
 */
export function saveResyncedInstallation(
  existing: InstallationRecord,
  data: InstallData,
  nowIso: string = new Date().toISOString(),
): InstallationRecord {
  return {
    ...installationRecordFromInstall(data, nowIso),
    installedAt: existing.installedAt,
    token: existing.token,
    tokenExpiresAt: existing.tokenExpiresAt,
    tokenKid: existing.tokenKid,
  };
}

export function createInstallHandlers(options: InstallHandlerOptions): Hono {
  const app = new Hono();
  const maxSkew = options.maxSkewSeconds ?? MAX_TIMESTAMP_SKEW_SECONDS;

  async function guard(
    id: string | undefined,
    timestamp: string | undefined,
    signatureHeader: string | undefined,
    rawBody: string,
  ): Promise<{ ok: true; id: string } | { ok: false; status: 401; reason: string }> {
    if (!id || !timestamp || !signatureHeader) {
      return { ok: false, status: 401, reason: "missing signature headers" };
    }
    const checked = verifyQueekSignatureDetailed(
      { id, timestamp, body: rawBody, signatureHeader, secret: options.appSecret },
      { nowSeconds: options.nowSeconds, maxSkewSeconds: maxSkew },
    );
    if (!checked.ok) {
      return {
        ok: false,
        status: 401,
        reason: checked.reason === "stale_timestamp" ? "stale timestamp" : "signature mismatch",
      };
    }
    return { ok: true, id };
  }

  function parseEnvelope(rawBody: string): HandoffEnvelopeAny | null {
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (typeof parsed !== "object" || parsed === null) return null;
      return parsed as HandoffEnvelopeAny;
    } catch {
      return null;
    }
  }

  app.post("/install", async (c) => {
    const rawBody = await c.req.text();
    const checked = await guard(
      c.req.header(WEBHOOK_ID_HEADER),
      c.req.header(WEBHOOK_TIMESTAMP_HEADER),
      c.req.header(WEBHOOK_SIGNATURE_HEADER),
      rawBody,
    );
    if (!checked.ok) return c.json({ ok: false, error: checked.reason }, checked.status);

    const envelope = parseEnvelope(rawBody);
    if (!envelope) return c.json({ ok: false, error: "invalid_envelope" }, 400);
    if (envelope.type !== INSTALL_EVENT) {
      return c.json({ ok: false, error: "unexpected event type" }, 400);
    }
    if (
      !envelope.data ||
      typeof envelope.data !== "object" ||
      typeof (envelope.data as InstallData).installation?.id !== "string" ||
      typeof (envelope.data as InstallData).api_base !== "string"
    ) {
      return c.json({ ok: false, error: "invalid install payload" }, 400);
    }

    // Atomic claim on the HEADER id (never the body id): exactly one
    // same-id delivery runs the callback.
    if (!(await options.store.claimWebhookId(checked.id))) {
      return c.json({ ok: false, error: "duplicate delivery" }, 409);
    }
    try {
      if (options.onInstall) {
        await options.onInstall(envelope as InstallEnvelope);
      } else {
        // A resync redelivers the install envelope for an EXISTING
        // installation: merge idempotently (keep `installedAt` + the cached
        // token) instead of resetting the row.
        const data = (envelope as InstallEnvelope).data;
        const existing = await options.store.getInstallation(data.installation.id);
        await options.store.saveInstallation(
          existing
            ? saveResyncedInstallation(existing, data, new Date().toISOString())
            : installationRecordFromInstall(data, new Date().toISOString()),
        );
      }
    } catch {
      // Non-2xx on purpose: Queek revokes the key and the merchant retries
      // as a fresh install. The claim is released so the retry can land.
      await options.store.releaseWebhookId(checked.id);
      return c.json({ ok: false, error: "install_failed" }, 500);
    }
    return c.json({ ok: true });
  });

  app.post("/uninstall", async (c) => {
    const rawBody = await c.req.text();
    const checked = await guard(
      c.req.header(WEBHOOK_ID_HEADER),
      c.req.header(WEBHOOK_TIMESTAMP_HEADER),
      c.req.header(WEBHOOK_SIGNATURE_HEADER),
      rawBody,
    );
    if (!checked.ok) return c.json({ ok: false, error: checked.reason }, checked.status);

    const envelope = parseEnvelope(rawBody);
    if (!envelope) return c.json({ ok: false, error: "invalid_envelope" }, 400);
    if (envelope.type !== UNINSTALL_EVENT) {
      return c.json({ ok: false, error: "unexpected event type" }, 400);
    }

    if (!(await options.store.claimWebhookId(checked.id))) {
      return c.json({ ok: false, error: "duplicate delivery" }, 409);
    }
    try {
      if (options.onUninstall) {
        await options.onUninstall(envelope as UninstallEnvelope);
      } else {
        await options.store.deleteInstallation((envelope as UninstallEnvelope).data.installation.id);
      }
    } catch {
      await options.store.releaseWebhookId(checked.id);
      return c.json({ ok: false, error: "uninstall_failed" }, 500);
    }
    return c.json({ ok: true });
  });

  app.post("/settings", async (c) => {
    const rawBody = await c.req.text();
    const checked = await guard(
      c.req.header(WEBHOOK_ID_HEADER),
      c.req.header(WEBHOOK_TIMESTAMP_HEADER),
      c.req.header(WEBHOOK_SIGNATURE_HEADER),
      rawBody,
    );
    if (!checked.ok) return c.json({ ok: false, error: checked.reason }, checked.status);

    const envelope = parseEnvelope(rawBody);
    if (!envelope) return c.json({ ok: false, error: "invalid_envelope" }, 400);
    if (envelope.type !== SETTINGS_EVENT) {
      return c.json({ ok: false, error: "unexpected event type" }, 400);
    }

    if (!(await options.store.claimWebhookId(checked.id))) {
      return c.json({ ok: false, error: "duplicate delivery" }, 409);
    }
    try {
      if (options.onSettings) {
        await options.onSettings(envelope as SettingsEnvelope);
      } else {
        const data = (envelope as SettingsEnvelope).data;
        const existing = await options.store.getInstallation(data.installation.id);
        if (!existing) {
          await options.store.releaseWebhookId(checked.id);
          return c.json({ ok: false, error: "unknown_installation" }, 404);
        }
        await options.store.saveInstallation({
          ...existing,
          settings: data.settings,
          updatedAt: new Date().toISOString(),
        });
      }
    } catch {
      await options.store.releaseWebhookId(checked.id);
      return c.json({ ok: false, error: "settings_failed" }, 500);
    }
    return c.json({ ok: true });
  });

  return app;
}
