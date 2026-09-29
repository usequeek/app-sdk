/**
 * `@usequeek/app-sdk` — the shared kit every Queek app is built from.
 *
 * Queek speaks Standard Webhooks (`webhook-id`, `webhook-timestamp`,
 * `webhook-signature` over `{id}.{timestamp}.{raw body}`, keyed by the
 * decoded `whsec_…` bytes) on two channels: the install handoff (signed
 * with the APP secret) and topic deliveries (signed with the
 * PER-INSTALLATION endpoint secret). The Merchant API takes the
 * installation credential as `X-Client-Key`.
 */

export {
  API_KEY_EXPIRED_CODE,
  APP_PRIVATE_KEY_FORMS,
  decodePrivateKeyInput,
  API_KEY_REVOKED_CODE,
  APP_INSTALLATION_GONE_CODE,
  APP_INSTALLATION_PENDING_CODE,
  APP_JWT_SKEW_SECONDS,
  APP_JWT_TTL_SECONDS,
  APP_TOKEN_REVOKED_CODE,
  type AppCredential,
  AppMintHaltedError,
  INVALID_CLIENT_CODE,
  INVALID_CLIENT_KEY_CODE,
  InvalidAppCredentialError,
  isAppTokenRevoked,
  isInstallationGone,
  isInstallationPending,
  isInvalidClient,
  isResyncCooldown,
  isTokenRefusal,
  loadAppCredential,
  MAX_MINT_ATTEMPTS,
  MINT_BACKOFF_BASE_MS,
  MINT_BACKOFF_MAX_MS,
  RESYNC_COOLDOWN_CODE,
  RETRY_JITTER_MAX_MS,
  type SignAppJwtOptions,
  signAppJwt,
  TOKEN_VALIDITY_SKEW_SECONDS,
  TOO_MANY_REQUESTS_CODE,
  UnknownInstallationError,
} from "./app-auth.js";
export {
  backgroundTaskCount,
  type CatchupFailure,
  type CatchupInstallation,
  type CatchupOptions,
  type CatchupResult,
  type DetachOptions,
  detach,
  runInstallationCatchup,
} from "./background.js";
export {
  apiHostsFromEnv,
  createQueekClient,
  DEFAULT_API_HOSTS,
  devApiHostsFromEnv,
  InvalidApiBaseError,
  MERCHANT_API_PATH,
  type MerchantPaths,
  newIdempotencyKey,
  type OperationResponse,
  QueekApiError,
  type QueekClient,
  type QueekClientOptions,
  type QueekErrorDetails,
  queekApiErrorFromResponse,
  type RequestOptions,
  type RetryOptions,
  resolveApiBase,
  type StoreProfile,
} from "./client.js";
export {
  type AlertBody,
  type AlertSeverity,
  type CollectedDefinition,
  type CollectedDefinitionCreate,
  type CollectedDefinitionUpdate,
  type CollectedField,
  collectedDefinitions,
  createRecord,
  type MerchantAlert,
  type SetupNotice,
  type SetupNoticeBody,
  type SetupNoticeItem,
  type SetupNoticeStatus,
  type SuccessEnvelope,
  sendAlert,
  setSetupNotice,
} from "./collected.js";
export {
  decryptSecret,
  encryptSecret,
  parseStoreKey,
  storeKeyFingerprint,
} from "./crypto.js";
export {
  type CoreDelivery,
  type CoreHeaders,
  decodeBody,
  type DeliveryResult,
  type InstallDelivery,
  readHeader,
} from "./delivery.js";
export {
  APP_SOURCE,
  type AppInboundMessage,
  type AppOutboundMessage,
  DASHBOARD_SOURCE,
  type FrameBridgeOptions,
  listenToDashboard,
  sendReady,
} from "./frame.js";
export {
  type HandoffEnvelope,
  type HandoffEnvelopeAny,
  type HandoffInstallationRef,
  type HandoffStore,
  INSTALL_EVENT,
  type InstallData,
  type InstallEnvelope,
  RESYNC_EVENT,
  type ResyncEnvelope,
  SETTINGS_EVENT,
  type SettingsData,
  type SettingsEnvelope,
  UNINSTALL_EVENT,
  type UninstallData,
  type UninstallEnvelope,
} from "./handoff.js";
export {
  buildInstallationRecord,
  handleInstallDelivery,
  handleInstallRequest,
  type InstallCallbacks,
  type InstallHandlerOptions,
  saveResyncedInstallation,
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
  type ResyncListItem,
  type ResyncOptions,
  type ResyncResult,
  resyncFromQueek,
} from "./resync.js";
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
  createInstallationStore,
  createPostgresPool,
  INSTALLATION_SCHEMA_VERSION,
  type InstallationRecord,
  type InstallationStore,
  type InstallationStoreSelector,
  PostgresInstallationStore,
  type PostgresStoreOptions,
  SqliteInstallationStore,
  type SqliteStoreOptions,
  type WebhookSecretCandidate,
} from "./store.js";
export {
  APP_API_PATH,
  AppTokenProvider,
  type AppTokens,
  createAppTokenProvider,
  createInstallationClient,
  type InstallationClientOptions,
  mintPath,
  resolveAppApiBase,
  type TokenProviderOptions,
} from "./tokens.js";
export {
  handleWebhookDelivery,
  handleWebhookRequest,
  QUEEK_TOPIC_HEADER,
  type QueekWebhookEnvelope,
  type SecretResolution,
  type WebhookHandlerContext,
  type WebhookHandlerFn,
  type WebhookHandlerOptions,
} from "./webhooks.js";
