import {
  type HandoffEnvelopeAny,
  INSTALL_EVENT,
  type InstallData,
  type InstallEnvelope,
  RESYNC_EVENT,
  type ResyncEnvelope,
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
 * Framework-agnostic handlers for Queek's signed server-to-server handoff
 * (`AppInstallService::deliver()` in queek_backend), built on the Web
 * standard: `handleInstallRequest(request, options)` routes on the request
 * URL's last path segment (`install`, `uninstall`, `settings`) and answers
 * with a plain `Response`. Wire it into any framework (Next.js route
 * handlers, Express, Hono — see `@usequeek/app-sdk/hono` for the Hono
 * wrappers).
 *
 * Every handoff — install, uninstall, settings, resync — carries the
 * Standard Webhooks headers signed with the APP signing secret (`whsec_…`,
 * minted once at `app:register`). The app answers 2xx only after the
 * installation is durably stored; anything else makes Queek revoke the
 * just-minted key and mark the install failed (retry = a fresh install).
 *
 * The resync handoff (`type: app/resync`, backend
 * `AppInstallService::resyncPayload()`) redelivers the install-shaped data
 * — rotated `webhook_secret`, non-secret settings, and recovery copies of
 * `proxy_secret` / `embed_secret` / `app_id` — to the app's `settings_url`,
 * falling back to `install_url`. Both `install` and `settings` accept it
 * with the same signature/verification rules and apply it via the resync
 * merge (`saveResyncedInstallation`: refreshes secrets/settings/scopes,
 * keeps `installedAt` + the cached token, keeps stored values the resync
 * omits).
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
    proxySecret: data.proxy_secret,
    embedSecret: data.embed_secret ?? null,
    appId: data.app_id ?? null,
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
  const fresh = installationRecordFromInstall(data, nowIso);
  return {
    ...fresh,
    // A handoff without the key (older payloads) keeps what is stored.
    embedSecret: data.embed_secret === undefined ? (existing.embedSecret ?? null) : fresh.embedSecret,
    appId: data.app_id === undefined ? (existing.appId ?? null) : fresh.appId,
    installedAt: existing.installedAt,
    token: existing.token,
    tokenExpiresAt: existing.tokenExpiresAt,
    tokenKid: existing.tokenKid,
  };
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

/**
 * Handle one signed install-handoff delivery (`install`, `uninstall`, or
 * `settings`, taken from the request URL's last path segment) and answer
 * with a plain `Response` — same options, same behaviour, same
 * errors/status codes as the Hono wrapper. Only `POST` is served; anything
 * else answers 405, and an unrecognised trailing segment answers 404.
 */
export async function handleInstallRequest(
  request: Request,
  options: InstallHandlerOptions,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
  const pathname = new URL(request.url).pathname.replace(/\/+$/, "");
  const route = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (route === "install") return handleInstall(request, options);
  if (route === "uninstall") return handleUninstall(request, options);
  if (route === "settings") return handleSettings(request, options);
  return json({ ok: false, error: "unknown_route" }, 404);
}

async function guard(
  options: InstallHandlerOptions,
  id: string | null,
  timestamp: string | null,
  signatureHeader: string | null,
  rawBody: string,
): Promise<{ ok: true; id: string } | { ok: false; status: 401; reason: string }> {
  if (!id || !timestamp || !signatureHeader) {
    return { ok: false, status: 401, reason: "missing signature headers" };
  }
  const checked = verifyQueekSignatureDetailed(
    { id, timestamp, body: rawBody, signatureHeader, secret: options.appSecret },
    { nowSeconds: options.nowSeconds, maxSkewSeconds: options.maxSkewSeconds ?? MAX_TIMESTAMP_SKEW_SECONDS },
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

function isInstallPayload(data: unknown): data is InstallData {
  return (
    !!data &&
    typeof data === "object" &&
    typeof (data as InstallData).installation?.id === "string" &&
    typeof (data as InstallData).api_base === "string"
  );
}

/** Default resync apply: merge into the existing row (keeping
 * `installedAt`, the cached token and stored values the resync omits) or
 * store a fresh row when nothing is stored (post-outage recovery). */
async function applyResync(store: InstallationStore, data: InstallData): Promise<void> {
  const existing = await store.getInstallation(data.installation.id);
  await store.saveInstallation(
    existing
      ? saveResyncedInstallation(existing, data, new Date().toISOString())
      : installationRecordFromInstall(data, new Date().toISOString()),
  );
}

async function handleInstall(request: Request, options: InstallHandlerOptions): Promise<Response> {
  const rawBody = await request.text();
  const checked = await guard(
    options,
    request.headers.get(WEBHOOK_ID_HEADER),
    request.headers.get(WEBHOOK_TIMESTAMP_HEADER),
    request.headers.get(WEBHOOK_SIGNATURE_HEADER),
    rawBody,
  );
  if (!checked.ok) return json({ ok: false, error: checked.reason }, checked.status);

  const envelope = parseEnvelope(rawBody);
  if (!envelope) return json({ ok: false, error: "invalid_envelope" }, 400);
  // The platform resync handoff redelivers the install-shaped data under
  // `type: app/resync` (same signed channel, same verification): it lands
  // here as well as on `settings` (the backend aims at `settings_url`
  // first, falling back to `install_url`).
  if (envelope.type !== INSTALL_EVENT && envelope.type !== RESYNC_EVENT) {
    return json({ ok: false, error: "unexpected event type" }, 400);
  }
  if (!isInstallPayload(envelope.data)) {
    return json({ ok: false, error: "invalid install payload" }, 400);
  }

  // Atomic claim on the HEADER id (never the body id): exactly one
  // same-id delivery runs the callback.
  if (!(await options.store.claimWebhookId(checked.id))) {
    return json({ ok: false, error: "duplicate delivery" }, 409);
  }
  try {
    if (options.onInstall) {
      // A resync envelope is install-shaped, so the install callback
      // handles it (apps merge via `saveResyncedInstallation` there).
      await options.onInstall(envelope as InstallEnvelope);
    } else {
      // A resync redelivers the install envelope for an EXISTING
      // installation: merge idempotently (keep `installedAt` + the cached
      // token) instead of resetting the row.
      await applyResync(options.store, (envelope as ResyncEnvelope).data);
    }
  } catch {
    // Non-2xx on purpose: Queek revokes the key and the merchant retries
    // as a fresh install. The claim is released so the retry can land.
    await options.store.releaseWebhookId(checked.id);
    return json({ ok: false, error: "install_failed" }, 500);
  }
  return json({ ok: true }, 200);
}

async function handleUninstall(request: Request, options: InstallHandlerOptions): Promise<Response> {
  const rawBody = await request.text();
  const checked = await guard(
    options,
    request.headers.get(WEBHOOK_ID_HEADER),
    request.headers.get(WEBHOOK_TIMESTAMP_HEADER),
    request.headers.get(WEBHOOK_SIGNATURE_HEADER),
    rawBody,
  );
  if (!checked.ok) return json({ ok: false, error: checked.reason }, checked.status);

  const envelope = parseEnvelope(rawBody);
  if (!envelope) return json({ ok: false, error: "invalid_envelope" }, 400);
  if (envelope.type !== UNINSTALL_EVENT) {
    return json({ ok: false, error: "unexpected event type" }, 400);
  }

  if (!(await options.store.claimWebhookId(checked.id))) {
    return json({ ok: false, error: "duplicate delivery" }, 409);
  }
  try {
    if (options.onUninstall) {
      await options.onUninstall(envelope as UninstallEnvelope);
    } else {
      await options.store.deleteInstallation((envelope as UninstallEnvelope).data.installation.id);
    }
  } catch {
    await options.store.releaseWebhookId(checked.id);
    return json({ ok: false, error: "uninstall_failed" }, 500);
  }
  return json({ ok: true }, 200);
}

async function handleSettings(request: Request, options: InstallHandlerOptions): Promise<Response> {
  const rawBody = await request.text();
  const checked = await guard(
    options,
    request.headers.get(WEBHOOK_ID_HEADER),
    request.headers.get(WEBHOOK_TIMESTAMP_HEADER),
    request.headers.get(WEBHOOK_SIGNATURE_HEADER),
    rawBody,
  );
  if (!checked.ok) return json({ ok: false, error: checked.reason }, checked.status);

  const envelope = parseEnvelope(rawBody);
  if (!envelope) return json({ ok: false, error: "invalid_envelope" }, 400);
  // The platform resync handoff (`type: app/resync`) is delivered to the
  // app's `settings_url` first: it lands here with the install-shaped
  // data, so it takes the resync merge — never the settings callback,
  // whose envelope shape does not fit.
  if (envelope.type !== SETTINGS_EVENT && envelope.type !== RESYNC_EVENT) {
    return json({ ok: false, error: "unexpected event type" }, 400);
  }

  if (envelope.type === RESYNC_EVENT) {
    if (!isInstallPayload(envelope.data)) {
      return json({ ok: false, error: "invalid install payload" }, 400);
    }
    if (!(await options.store.claimWebhookId(checked.id))) {
      return json({ ok: false, error: "duplicate delivery" }, 409);
    }
    try {
      await applyResync(options.store, (envelope as ResyncEnvelope).data);
    } catch {
      await options.store.releaseWebhookId(checked.id);
      return json({ ok: false, error: "settings_failed" }, 500);
    }
    return json({ ok: true }, 200);
  }

  if (!(await options.store.claimWebhookId(checked.id))) {
    return json({ ok: false, error: "duplicate delivery" }, 409);
  }
  try {
    if (options.onSettings) {
      await options.onSettings(envelope as SettingsEnvelope);
    } else {
      const data = (envelope as SettingsEnvelope).data;
      const existing = await options.store.getInstallation(data.installation.id);
      if (!existing) {
        await options.store.releaseWebhookId(checked.id);
        return json({ ok: false, error: "unknown_installation" }, 404);
      }
      await options.store.saveInstallation({
        ...existing,
        settings: data.settings,
        updatedAt: new Date().toISOString(),
      });
    }
  } catch {
    await options.store.releaseWebhookId(checked.id);
    return json({ ok: false, error: "settings_failed" }, 500);
  }
  return json({ ok: true }, 200);
}
