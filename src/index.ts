/**
 * `@queek/app-sdk` — the shared kit every Queek app is built from.
 *
 * Queek speaks Standard Webhooks (`webhook-id`, `webhook-timestamp`,
 * `webhook-signature` over `{id}.{timestamp}.{raw body}`, keyed by the
 * decoded `whsec_…` bytes) on two channels: the install handoff (signed
 * with the APP secret) and topic deliveries (signed with the
 * PER-INSTALLATION endpoint secret). The Merchant API takes the
 * installation credential as `X-Client-Key`.
 */

export {
  apiHostsFromEnv,
  createQueekClient,
  DEFAULT_API_HOSTS,
  InvalidApiBaseError,
  MERCHANT_API_PATH,
  type MerchantPaths,
  newIdempotencyKey,
  type OperationResponse,
  QueekApiError,
  type QueekClient,
  type QueekClientOptions,
  type QueekErrorDetails,
  type RequestOptions,
  type RetryOptions,
  resolveApiBase,
  type StoreProfile,
} from "./client.js";
export {
  decryptSecret,
  encryptSecret,
  parseStoreKey,
  storeKeyFingerprint,
} from "./crypto.js";
export {
  type HandoffEnvelope,
  type HandoffEnvelopeAny,
  type HandoffInstallationRef,
  type HandoffStore,
  INSTALL_EVENT,
  type InstallData,
  type InstallEnvelope,
  SETTINGS_EVENT,
  type SettingsData,
  type SettingsEnvelope,
  UNINSTALL_EVENT,
  type UninstallData,
  type UninstallEnvelope,
} from "./handoff.js";
export {
  buildInstallationRecord,
  createInstallHandlers,
  type InstallCallbacks,
  type InstallHandlerOptions,
} from "./install-handlers.js";
export {
  createLogger,
  type LogFields,
  type Logger,
  type LoggerOptions,
  type LogLevel,
  REDACTED,
} from "./logger.js";
export {
  MAX_TIMESTAMP_SKEW_SECONDS,
  SECRET_PREFIX,
  type SignatureFailure,
  type SignatureInput,
  secretKeyBytes,
  signQueekPayload,
  type VerifyOptions,
  verifyQueekSignature,
  verifyQueekSignatureDetailed,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "./signatures.js";
export {
  type InstallationRecord,
  type InstallationStore,
  SqliteInstallationStore,
  type SqliteStoreOptions,
  type WebhookSecretCandidate,
} from "./store.js";
export {
  createWebhookHandler,
  QUEEK_TOPIC_HEADER,
  type QueekWebhookEnvelope,
  type SecretResolution,
  type WebhookHandlerContext,
  type WebhookHandlerFn,
  type WebhookHandlerOptions,
} from "./webhooks.js";
