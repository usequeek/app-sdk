/**
 * Typed payloads for Queek's server-to-server install handoff.
 *
 * Source of truth: queek_backend `App\Services\Apps\AppInstallService`
 * (`installPayload()`, `uninstallPayload()`, `settingsPayload()`,
 * `handoffBody()`). The signed body envelope is:
 *
 *   { id, type, api_version: "v1", created_at, data }
 *
 * `type` is `app/installed` | `app/uninstalled` | `app/settings_updated`.
 * The handoff POST carries the Standard Webhooks headers (`webhook-id`,
 * `webhook-timestamp`, `webhook-signature`) signed with the APP's signing
 * secret (`whsec_…`, minted once at `app:register`), NOT the per-installation
 * webhook secret. The per-installation `webhook_secret` arrives INSIDE the
 * install payload (`data.webhook_secret`) — once — so the app can verify the
 * topic events it is about to receive.
 */

export const INSTALL_EVENT = "app/installed";
export const UNINSTALL_EVENT = "app/uninstalled";
export const SETTINGS_EVENT = "app/settings_updated";

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
   * No store-callable credential crosses the handoff any more (S1, SDK
   * 0.2.0): the app mints short-lived installation tokens with its
   * asymmetric app key (`acquireToken()`) and caches them encrypted in its
   * own database. The same envelope redelivers `webhook_secret` + the
   * non-secret settings snapshot on resync.
   */
  scopes: string[];
  settings: Record<string, unknown>;
  /** The installation endpoint's `whsec_…` secret, handed over ONCE per rotation. */
  webhook_secret: string | null;
  /**
   * The installation's `whsec_…` proxy secret (backend `proxy_secret`),
   * handed over ONCE per install/resync over the signed channel. The
   * booking app signs slot-claims with it; core verifies the HMAC
   * against the same installation secret. Null for apps without a
   * proxy — the key's absence is the signal. Source of truth:
   * queek_backend `App\Services\Apps\AppInstallService::installPayload()`.
   */
  proxy_secret: string | null;
  webhook_url: string | null;
  webhook_topics: string[];
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

export type HandoffEnvelopeAny = InstallEnvelope | UninstallEnvelope | SettingsEnvelope;
