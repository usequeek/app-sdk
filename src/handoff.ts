/**
 * Typed payloads for Queek's server-to-server install handoff.
 *
 * The signed body envelope is:
 *
 *   { id, type, api_version: "v1", created_at, data }
 *
 * `type` is `app/installed` | `app/uninstalled` | `app/settings_updated`
 * | `app/resync` | `app/scopes_update`. The handoff POST carries the
 * Standard Webhooks headers (`webhook-id`, `webhook-timestamp`,
 * `webhook-signature`) signed with the APP's signing secret (`whsec_…`,
 * minted when the app is registered on the Queek Developer page), NOT the
 * per-installation webhook secret. The per-installation `webhook_secret`
 * arrives INSIDE the install payload (`data.webhook_secret`) — once — so
 * the app can verify the topic events it is about to receive.
 *
 * `app/resync` is the installation resync handoff (delivered to the app's
 * `settings_url`, falling back to `install_url`): the install-shaped data
 * plus the resync-only `secret_rotated` flag, over the same signed channel
 * with the same verification rules. Both the `/install` and `/settings`
 * handlers accept it.
 *
 * See https://docs.usequeek.com/docs/apps/sdk
 */

export const INSTALL_EVENT = "app/installed";
export const UNINSTALL_EVENT = "app/uninstalled";
export const SETTINGS_EVENT = "app/settings_updated";
export const RESYNC_EVENT = "app/resync";
export const SCOPES_UPDATE_EVENT = "app/scopes_update";

export interface HandoffInstallationRef {
  id: string;
  p_id: string;
}

export interface HandoffStore {
  id: string;
  p_id: string | null;
  name: string;
  is_test: boolean;
}

export interface InstallData {
  installation: HandoffInstallationRef;
  store: HandoffStore;
  /** The Merchant API base for this store (e.g. https://api.usequeek.com/api/v1/merchant). */
  api_base: string;
  /**
   * No store-callable credential crosses the handoff: the app mints
   * short-lived installation tokens with its asymmetric app key
   * (`acquireToken()`) and caches them encrypted in its own database. The
   * same envelope redelivers `webhook_secret` + the non-secret settings
   * snapshot on resync.
   */
  scopes: string[];
  settings: Record<string, unknown>;
  /** The installation endpoint's `whsec_…` secret, handed over ONCE per rotation. */
  webhook_secret: string | null;
  /**
   * The installation's `whsec_…` proxy secret, handed over ONCE per
   * install/resync over the signed channel. Queek signs storefront proxy
   * reads with it (see `proxy.ts`), and an app can sign claims back to
   * Queek with it (for example slot-claims); Queek verifies the HMAC
   * against the same installation secret. Null for apps without a proxy —
   * the key's absence is the signal.
   */
  proxy_secret: string | null;
  /**
   * The installation's `embsec_…` embed secret, handed over on
   * install/resync: the HS256 key of the dashboard session tokens its
   * embedded merchant page receives (verify with `@usequeek/app-sdk/server`
   * `verifySessionToken`). Null for apps without a merchant page.
   */
  embed_secret?: string | null;
  /**
   * The app's own id, exactly as the session token signs it (`app_id`
   * claim) — the verifier binds it.
   */
  app_id?: string | null;
  webhook_url: string | null;
  webhook_topics: string[];
  /**
   * Resync-only: whether the delivery rotated the endpoint secret
   * (`webhook_secret` holds the new secret when true, null when the
   * installation has no webhook endpoint). Absent on install.
   */
  secret_rotated?: boolean | null;
}

export interface UninstallData {
  installation: HandoffInstallationRef;
  store: HandoffStore;
}

export interface SettingsData {
  installation: HandoffInstallationRef;
  store: HandoffStore | null;
  settings: Record<string, unknown>;
}

export interface HandoffEnvelope<TType extends string, TData> {
  id: string;
  type: TType;
  api_version: "v1";
  created_at: string;
  data: TData;
}

export type InstallEnvelope = HandoffEnvelope<typeof INSTALL_EVENT, InstallData>;
export type UninstallEnvelope = HandoffEnvelope<typeof UNINSTALL_EVENT, UninstallData>;
export type SettingsEnvelope = HandoffEnvelope<typeof SETTINGS_EVENT, SettingsData>;
/**
 * The installation resync handoff: the install-shaped data (plus the
 * resync-only `secret_rotated` flag) under `type: app/resync`. Handled by
 * the install AND settings handlers via the resync merge path.
 */
export type ResyncEnvelope = HandoffEnvelope<typeof RESYNC_EVENT, InstallData>;

/**
 * The installation `p_id` Queek addresses a handoff to. The
 * scopes_update handoff carries ONLY the `p_id` (never the UUID), so `id`
 * is optional here: present on install-shaped payloads, absent on
 * `app/scopes_update`.
 */
export interface HandoffPidRef {
  /** A string on the wire; the SDK normalises via `normalisePid`, so a JSON integer still matches. */
  p_id: string | number;
  id?: string;
}

/**
 * The grant-change handoff (sent per grant change over the same signed
 * channel): the installation `p_id` + the EFFECTIVE grant
 * (grant ∩ tracked manifest — what the installation's tokens now carry,
 * byte for byte). Carries no settings and no secrets: the app refreshes
 * its cached grant from `scopes` and drops its cached token when the
 * grant moved.
 */
export interface ScopesUpdateData {
  installation: HandoffPidRef;
  app_id: string;
  store: HandoffStore;
  /** The Merchant API base for this store (same contract as the install handoff). */
  api_base: string;
  scopes: string[];
}

export type ScopesUpdateEnvelope = HandoffEnvelope<typeof SCOPES_UPDATE_EVENT, ScopesUpdateData>;

export type HandoffEnvelopeAny =
  | InstallEnvelope
  | UninstallEnvelope
  | SettingsEnvelope
  | ResyncEnvelope
  | ScopesUpdateEnvelope;
