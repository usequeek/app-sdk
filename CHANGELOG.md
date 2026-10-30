# Changelog

All notable changes to `@usequeek/app-sdk`. Releases before this file are listed on the [GitHub releases page](https://github.com/usequeek/app-sdk/releases).

## 0.8.0 - 2026-10-30

### Added

- Queek AI tools and actions. The manifest `ai` section has types (`ManifestAi`, `ManifestAiTool`, `ManifestAiAction`, `ManifestAiInput`, and the input and output type lists) and `MANIFEST_AI_RESERVED_INPUT_KEYS` with `isReservedAiInputKey` for the input names Queek signs or owns. `handleAiToolRequest()` (and `createAiToolHandler()` in `@usequeek/app-sdk/hono`) serves the signed `GET ai/{tool}` call: only a declared tool answers a `surface=ai` call (403 otherwise), a storefront or dashboard call at that path is refused, and a handler that answers anything but an object gets a 500. `onAiAction()` (also in `@usequeek/app-sdk/browser`, and as `onAiAction` on `listenToDashboard`) receives the `ai-action` message Queek AI sends to an action's page, from the exact dashboard origin only. Stage the values and never save on load. See the README, "Queek AI tools and actions".
- The signed proxy `surface` (`storefront`, `dashboard` or `ai`). `verifyProxyQuery`, `verifyProxyQueryDetailed` and `verifyProxyDelivery` take `expectedSurface` and refuse a genuine call signed for another surface (`surface_mismatch`; 403 from `verifyProxyDelivery`). The verified result and the `onVerified` argument carry `surface`.
- `ManifestSetting` (the manifest `settings` entry type) with the opt-in `ai_editable` flag, and `aiEditableSettingKeys`. Queek AI changes an installed app's setting only when the manifest marks it `ai_editable: true`. A `secret` never can, and each change still needs the merchant's confirmation.

### Changed

- `handleProxyRequest` answers 403 `forbidden` to a `surface=ai` call instead of handing it to `onVerified`. Queek AI reaches an app only through a declared tool.
- `ProxyVerification` failures can carry status 403 as well as 401.

## 0.7.2 - 2026-10-18

### Fixed

- `installThemeListener` now announces `ready` as its documentation says. It sent nothing unless the caller passed `postTarget`, so an app wired with the browser primitives (the starter's bridge) never told the dashboard it was ready, and the embedded page failed with "didn't respond". It now announces to the framing parent window by default. An explicit `postTarget` still wins, and a top-level document posts nothing.

### Changed

- The generated Merchant API types follow the live contract. The additions are new endpoints and fields only.

## 0.7.1 - 2026-10-13

### Fixed

- The generated Merchant API types no longer expose internal class names. Four component schemas are named `Collection`, `Order`, `OrderItem` and `Product`; the exported `MerchantCollection`, `QueekStoreOrder`, `QueekStoreOrderItem` and `QueekStoreProduct` types are unchanged.

## 0.7.0 - 2026-10-12

### Fixed

- `createInstallationClient().requestWithRetry()` sent a new `Idempotency-Key` on every attempt, so a write retried after a timeout could run twice. All attempts of one write now share one key.
- Install and webhook handlers answered 500 without recording why. They now call `onError(error, { stage, eventId, topic })`, or log the error (secrets redacted) to stderr when `onError` is not set.
- An uninstall or settings payload with no installation id answered 500. It now answers 400.
- Signature freshness accepted timestamps such as `1e3` or `0x10`. Only plain unix-second integers inside the window pass.
- A 2xx response whose body is not JSON was returned as a mistyped value. It now throws `QueekApiError` with code `invalid_response`.
- The published package no longer ships source maps that point at files it does not contain.

### Added

- Per-attempt timeout (`timeoutMs`, default 30 seconds) on every HTTP call, plus the error codes `request_timeout` and `request_aborted`. A caller abort is never retried.
- `QueekApiError.cause` keeps the original error, and `QueekApiError.isRetryable` says whether a retry can help.
- `requestWithRetry()` now retries 502, 503 and 504, uses jittered backoff, and throws at once when `Retry-After` is longer than `maxRetryAfterMs` (default 30 seconds).
- `paginate()` iterates every row of a cursor-paginated list.
- `package.json`: `bugs`, `homepage`, `author`, `keywords` and `sideEffects: false`.

### Changed

- Backoff between retries is now jittered between half and the full ceiling.
- Error messages for decryption, minting, revoking and missing `fetch` say what to do next. `useQueek()` outside `<QueekProvider>` now throws "useQueek must be called inside <QueekProvider>. Wrap the app root in <QueekProvider>."
- The README is rewritten, and every TypeScript sample in it is typechecked.
- The bundled Merchant API types match production. Product responses no longer carry `collection_category_ids`; read `collections[].id`. Product writes and bulk update take `collection_ids`.
