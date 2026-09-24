# Changelog

All notable changes to `@usequeek/app-sdk` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Regenerated types from the live Merchant API contract (decision 2026-09-24-one-public-product-object): the product list + retrieve now return the one public `ProductResource` — the same object as `products/*` webhooks (`id` = int p_id, `uid` = UUID, plus `url`, `storefront_price`, `storefront_compare_at_price`, `primary_image_url`, `variants[]` with integer `id` = variant p_id, `images[]`; no cost/wholesale/discount internals). The product read shape is public-only: no internal fields to strip.

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
