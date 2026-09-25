# Changelog

All notable changes to `@usequeek/app-sdk` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-09-25

GitHub-style app credentials (slice S1 of `app-credentials-and-databases`, built against the
`/api/v1/apps` wire contract in parallel with the backend B1/B2 — the backend is not deployed yet).

### Changed

- **BREAKING:** the install handoff no longer carries a store-callable `api_key`, and the store
  no longer has an `api_key_enc` column. Installations cache one minted token instead
  (`token_enc` + `token_expires_at` + `token_kid`); opening a 0.1.x SQLite database migrates it
  (legacy key ciphertext is discarded — minted tokens replace it).
- `InstallationRecord` carries the cached token (`token`/`tokenExpiresAt`/`tokenKid`, memory-only
  plaintext); `InstallationStore` gains `listInstallations()`, `clearCachedToken()`,
  `clearAllCachedTokens()`.
- The default install handler merges a redelivered install envelope for an existing installation
  idempotently (resync path): secret + settings refresh, `installedAt` and the cached token kept.
- The logger additionally redacts bare RS256 JWTs and PEM private-key blocks.
- `.env.example` files document `APP_KEY_ID` + `APP_PRIVATE_KEY`.

### Added

- `app-auth.ts`: `loadAppCredential` (`APP_SLUG`/`APP_KEY_ID`/`APP_PRIVATE_KEY`, RSA PEM validated
  at boot), `signAppJwt` (RS256 via `node:crypto` only, `iat` now − 60 s, `exp` window 540 s,
  `kid` header), and the wire-contract error codes in exactly one place (`INVALID_CLIENT_CODE`,
  `APP_ACCESS_REVOKED_CODE`, `APP_INSTALLATION_GONE_CODE`).
- `tokens.ts`: `createAppTokenProvider` (`acquireToken` with 5-minute validity skew, in-process
  single-flight per installation, exact contract error mapping: `invalid_client` halts, kill-switch
  403 drops all tokens and halts, `app_installation_gone` purges, 429 + jitter, bounded 5xx
  backoff) and `createInstallationClient` (every call through `acquireToken`; merchant 401/403 →
  drop, re-mint once, retry once).
- `resync.ts`: `resyncFromQueek` (paginated list → per-installation resync with 429-cooldown skip
  → drop cached tokens → purge absent installations; connectivity scope only).
- `store.ts`: `PostgresInstallationStore` (`pg`, pool max 2, advisory-locked schema +
  `schema_version` row), `createInstallationStore` (`DATABASE_URL` → Postgres, else SQLite —
  refused in production), AES-GCM envelope unchanged.
- `background.ts`: `runInstallationCatchup` (uniform 0–600 s start jitter, per-install error
  isolation, concurrency ≤ pool size, honors 429 once per installation).
- CI runs the Postgres suite via a `postgres:16` service container (`DATABASE_URL` always set);
  without `DATABASE_URL` those tests skip cleanly.
- Vitest suites against a local fake Queek server (JWT-verifying mint, paginated list, resync,
  merchant refusals): cache-hit/expiry/single-flight/two-container minting, every contract error,
  wipe → resync → connectivity, cooldown skip, purge-absent, production-refuses-SQLite.

## [Unreleased]

### Changed

- Regenerated types from the live Merchant API contract (decision 2026-09-24-one-public-product-object): the product list + retrieve now return the one public `ProductResource` — the same object as `products/*` webhooks (`id` = int p_id, `uid` = UUID, plus `url`, `storefront_price`, `storefront_compare_at_price`, `primary_image_url`, `variants[]` with integer `id` = variant p_id, `images[]`; no cost/wholesale/discount internals). The product read shape is public-only: no internal fields to strip.

### Added

- Installation-bound app writes for the S3a contract (queek_backend@c1fa1c31; snapshot intentionally ahead of production — see `openapi/merchant.drift.json`, re-check after the S3a deploy): `setSetupNotice` (PUT app/setup, full-sheet write), `sendAlert` (POST app/alerts, severity/title/message plus optional dedupe key), `collectedDefinitions.list/create/update` (the calling installation's own collected types), and `createRecord` (POST records with a fresh Idempotency-Key per submit; `values` is a `{field_key: value}` object per the backend's FormsAppCollectedTest — the Scramble `string[]` is imprecise).

## [0.1.0] - 2026-09-24

First release: the kit every Queek app is built from.

### Added

- Standard Webhooks signature verification (`verifyQueekSignature`) with timestamp-skew enforcement.
- Hono install/uninstall/settings handlers (`createInstallHandlers`) with encrypted persistence defaults.
- Typed Merchant API client (`createQueekClient`): `X-Client-Key` auth, `Idempotency-Key` on writes, typed errors, 429 retry helpers. Types generated from the committed `openapi/merchant.json` snapshot.
- Topic webhook dispatch (`createWebhookHandler`) with per-installation secrets and `webhook-id` dedupe.
- Encrypted SQLite installation store (`SqliteInstallationStore`, AES-GCM).
- Detached background-task helper (`detach`) with delivery-result tracking.
- Redacting JSON logger (`createLogger`).
- Dev-only `QUEEK_DEV_API_HOSTS` API-host override (refused when `NODE_ENV=production`).
