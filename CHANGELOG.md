# Changelog

All notable changes to `@usequeek/app-sdk`. Releases before this file are listed on the [GitHub releases page](https://github.com/usequeek/app-sdk/releases).

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
