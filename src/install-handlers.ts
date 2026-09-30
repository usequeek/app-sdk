import {
  type CoreHeaders,
  type DeliveryResult,
  decodeBody,
  type InstallDelivery,
  readHeader,
  toResponse,
} from "./delivery.js";
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
 * (`AppInstallService::deliver()` in queek_backend) in three thin layers:
 * layer 1 `handleInstallDelivery(input, options)` takes plain data
 * (untouched body bytes + headers, plus method/path for routing) and
 * returns a plain `{ status, body }` result — zero request/response types,
 * so whatever request object each framework supports works; layer 2
 * `handleInstallRequest(request, options)` adapts the Web standard onto
 * layer 1; layer 3 (`@usequeek/app-sdk/hono`) adapts Hono onto layer 2.
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
 * keeps `installedAt` + the cached token unless the grant changed (a scope
 * change drops it so the next call re-mints), keeps stored values the
 * resync omits).
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
    // existing-row path, which keeps the cached token unless the grant
    // changed.
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
 * Compare two scope grants order-insensitively. Any difference (added,
 * removed, or replaced scope) means the grant changed.
 */
export function installationScopesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((scope, index) => scope === sortedB[index]);
}

/**
 * Merge a re-delivered install envelope (resync or re-grant) into an
 * existing row: refresh the ref fields, scopes, settings and webhook
 * secret, but keep the original `installedAt`. The cached installation
 * token survives a secret rotation (minted tokens stay valid) but is
 * dropped whenever the grant changes — a token minted for the old scopes
 * fails with `insufficient_scope` on the new grant, so the next call
 * re-mints. `resyncFromQueek` drops tokens explicitly when it wants fresh
 * ones.
 */
export function saveResyncedInstallation(
  existing: InstallationRecord,
  data: InstallData,
  nowIso: string = new Date().toISOString(),
): InstallationRecord {
  const fresh = installationRecordFromInstall(data, nowIso);
  const grantChanged = !installationScopesEqual(existing.scopes, data.scopes);
  return {
    ...fresh,
    // A handoff without the key (older payloads) keeps what is stored.
    embedSecret: data.embed_secret === undefined ? (existing.embedSecret ?? null) : fresh.embedSecret,
    appId: data.app_id === undefined ? (existing.appId ?? null) : fresh.appId,
    installedAt: existing.installedAt,
    token: grantChanged ? null : existing.token,
    tokenExpiresAt: grantChanged ? null : existing.tokenExpiresAt,
    tokenKid: grantChanged ? null : existing.tokenKid,
  };
}

/**
 * Layer 1: handle one signed install-handoff delivery (`install`,
 * `uninstall`, or `settings`, taken from the input path's last segment)
 * from plain data — no `Request`, no framework. Same options, same
 * behaviour, same errors/status codes at every layer.
 */
export async function handleInstallDelivery(
  input: InstallDelivery,
  options: InstallHandlerOptions,
): Promise<DeliveryResult> {
  if ((input.method ?? "POST").toUpperCase() !== "POST") {
    return { status: 405, body: { ok: false, error: "method_not_allowed" } };
  }
  const route = trailingSegment(input.path ?? "");
  const rawBody = decodeBody(input.rawBody);
  if (route === "install") return installDelivery(rawBody, input.headers, options);
  if (route === "uninstall") return uninstallDelivery(rawBody, input.headers, options);
  if (route === "settings") return settingsDelivery(rawBody, input.headers, options);
  return { status: 404, body: { ok: false, error: "unknown_route" } };
}

/** Last path segment of a pathname or full URL (query/fragment stripped, trailing slashes ignored). */
function trailingSegment(path: string): string {
  const withoutQuery = path.split("?", 1)[0] ?? "";
  const withoutFragment = withoutQuery.split("#", 1)[0] ?? "";
  const trimmed = withoutFragment.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/**
 * Layer 2: the Web-standard wrapper, built ONLY on layer 1 — reads
 * `await request.arrayBuffer()` + headers, calls the core, builds the
 * `Response`.
 */
export async function handleInstallRequest(
  request: Request,
  options: InstallHandlerOptions,
): Promise<Response> {
  return toResponse(
    await handleInstallDelivery(
      {
        rawBody: new Uint8Array(await request.arrayBuffer()),
        headers: request.headers,
        method: request.method,
        path: new URL(request.url).pathname,
      },
      options,
    ),
  );
}

async function guard(
  options: InstallHandlerOptions,
  headers: CoreHeaders,
  rawBody: string,
): Promise<{ ok: true; id: string } | { ok: false; status: 401; reason: string }> {
  const id = readHeader(headers, WEBHOOK_ID_HEADER);
  const timestamp = readHeader(headers, WEBHOOK_TIMESTAMP_HEADER);
  const signatureHeader = readHeader(headers, WEBHOOK_SIGNATURE_HEADER);
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
 * `installedAt`, the cached token unless the grant changed, and stored
 * values the resync omits) or store a fresh row when nothing is stored
 * (post-outage recovery). */
async function applyResync(store: InstallationStore, data: InstallData): Promise<void> {
  const existing = await store.getInstallation(data.installation.id);
  await store.saveInstallation(
    existing
      ? saveResyncedInstallation(existing, data, new Date().toISOString())
      : installationRecordFromInstall(data, new Date().toISOString()),
  );
}

async function installDelivery(
  rawBody: string,
  headers: CoreHeaders,
  options: InstallHandlerOptions,
): Promise<DeliveryResult> {
  const checked = await guard(options, headers, rawBody);
  if (!checked.ok) return { status: checked.status, body: { ok: false, error: checked.reason } };

  const envelope = parseEnvelope(rawBody);
  if (!envelope) return { status: 400, body: { ok: false, error: "invalid_envelope" } };
  // The platform resync handoff redelivers the install-shaped data under
  // `type: app/resync` (same signed channel, same verification): it lands
  // here as well as on `settings` (the backend aims at `settings_url`
  // first, falling back to `install_url`).
  if (envelope.type !== INSTALL_EVENT && envelope.type !== RESYNC_EVENT) {
    return { status: 400, body: { ok: false, error: "unexpected event type" } };
  }
  if (!isInstallPayload(envelope.data)) {
    return { status: 400, body: { ok: false, error: "invalid install payload" } };
  }

  // Atomic claim on the HEADER id (never the body id): exactly one
  // same-id delivery runs the callback.
  if (!(await options.store.claimWebhookId(checked.id))) {
    return { status: 409, body: { ok: false, error: "duplicate delivery" } };
  }
  try {
    if (options.onInstall) {
      // A resync envelope is install-shaped, so the install callback
      // handles it (apps merge via `saveResyncedInstallation` there).
      await options.onInstall(envelope as InstallEnvelope);
    } else {
      // A resync redelivers the install envelope for an EXISTING
      // installation: merge idempotently (keep `installedAt` + the cached
      // token unless the grant changed) instead of resetting the row.
      await applyResync(options.store, (envelope as ResyncEnvelope).data);
    }
  } catch {
    // Non-2xx on purpose: Queek revokes the key and the merchant retries
    // as a fresh install. The claim is released so the retry can land.
    await options.store.releaseWebhookId(checked.id);
    return { status: 500, body: { ok: false, error: "install_failed" } };
  }
  return { status: 200, body: { ok: true } };
}

async function uninstallDelivery(
  rawBody: string,
  headers: CoreHeaders,
  options: InstallHandlerOptions,
): Promise<DeliveryResult> {
  const checked = await guard(options, headers, rawBody);
  if (!checked.ok) return { status: checked.status, body: { ok: false, error: checked.reason } };

  const envelope = parseEnvelope(rawBody);
  if (!envelope) return { status: 400, body: { ok: false, error: "invalid_envelope" } };
  if (envelope.type !== UNINSTALL_EVENT) {
    return { status: 400, body: { ok: false, error: "unexpected event type" } };
  }

  if (!(await options.store.claimWebhookId(checked.id))) {
    return { status: 409, body: { ok: false, error: "duplicate delivery" } };
  }
  try {
    if (options.onUninstall) {
      await options.onUninstall(envelope as UninstallEnvelope);
    } else {
      await options.store.deleteInstallation((envelope as UninstallEnvelope).data.installation.id);
    }
  } catch {
    await options.store.releaseWebhookId(checked.id);
    return { status: 500, body: { ok: false, error: "uninstall_failed" } };
  }
  return { status: 200, body: { ok: true } };
}

async function settingsDelivery(
  rawBody: string,
  headers: CoreHeaders,
  options: InstallHandlerOptions,
): Promise<DeliveryResult> {
  const checked = await guard(options, headers, rawBody);
  if (!checked.ok) return { status: checked.status, body: { ok: false, error: checked.reason } };

  const envelope = parseEnvelope(rawBody);
  if (!envelope) return { status: 400, body: { ok: false, error: "invalid_envelope" } };
  // The platform resync handoff (`type: app/resync`) is delivered to the
  // app's `settings_url` first: it lands here with the install-shaped
  // data, so it takes the resync merge — never the settings callback,
  // whose envelope shape does not fit.
  if (envelope.type !== SETTINGS_EVENT && envelope.type !== RESYNC_EVENT) {
    return { status: 400, body: { ok: false, error: "unexpected event type" } };
  }

  if (envelope.type === RESYNC_EVENT) {
    if (!isInstallPayload(envelope.data)) {
      return { status: 400, body: { ok: false, error: "invalid install payload" } };
    }
    if (!(await options.store.claimWebhookId(checked.id))) {
      return { status: 409, body: { ok: false, error: "duplicate delivery" } };
    }
    try {
      await applyResync(options.store, (envelope as ResyncEnvelope).data);
    } catch {
      await options.store.releaseWebhookId(checked.id);
      return { status: 500, body: { ok: false, error: "settings_failed" } };
    }
    return { status: 200, body: { ok: true } };
  }

  if (!(await options.store.claimWebhookId(checked.id))) {
    return { status: 409, body: { ok: false, error: "duplicate delivery" } };
  }
  try {
    if (options.onSettings) {
      await options.onSettings(envelope as SettingsEnvelope);
    } else {
      const data = (envelope as SettingsEnvelope).data;
      const existing = await options.store.getInstallation(data.installation.id);
      if (!existing) {
        await options.store.releaseWebhookId(checked.id);
        return { status: 404, body: { ok: false, error: "unknown_installation" } };
      }
      await options.store.saveInstallation({
        ...existing,
        settings: data.settings,
        updatedAt: new Date().toISOString(),
      });
    }
  } catch {
    await options.store.releaseWebhookId(checked.id);
    return { status: 500, body: { ok: false, error: "settings_failed" } };
  }
  return { status: 200, body: { ok: true } };
}
