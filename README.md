# @usequeek/app-sdk

The SDK for building a Queek app on the public Merchant API and signed webhooks. Hono route helpers for the install handoff and topic webhooks, a typed Merchant API client (types generated from the live contract), GitHub-style app credentials (one asymmetric key per app, short-lived per-installation tokens minted on demand), resync recovery, and an encrypted installation store (SQLite for local/test, Postgres in production).

```sh
npm i @usequeek/app-sdk hono pg
```

Requires Node `>=22.14`. `hono` is a peer dependency so your app never carries two copies. `pg` is a regular dependency (the production store).

## Example

A minimal app: health check, install/uninstall/settings handlers, and one webhook topic:

```ts
import {
  createAppTokenProvider,
  createInstallHandlers,
  createWebhookHandler,
  loadAppCredential,
  SqliteInstallationStore,
} from "@usequeek/app-sdk";
import { Hono } from "hono";

const store = new SqliteInstallationStore({
  path: "./data/installations.db",
  storeKey: process.env.APP_ENCRYPTION_KEY!,
});
const tokens = createAppTokenProvider({
  credential: loadAppCredential({ appSlug: "hello" }), // APP_SLUG/APP_KEY_ID/APP_PRIVATE_KEY
  store,
});

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));
app.route("/", createInstallHandlers({ appSecret: process.env.QUEEK_APP_SECRET!, store }));
app.route(
  "/webhooks",
  createWebhookHandler({
    store,
    handlers: {
      "orders/updated": async (envelope, context) => {
        console.log("order update:", context.installation.storePid, envelope.data);
      },
    },
  }),
);

export default app;
```

Every Merchant API call goes through `createInstallationClient({ installationId, apiBase, tokens })`,
which resolves the installation's token via `acquireToken()` and sends it as `X-Client-Key`.

## Credential lifecycle (S1: GitHub-style installation tokens)

One asymmetric credential per app — no per-installation secrets cross the handoff any more.

1. **Generate a keypair** (once, offline) and keep the private key in the founder's password
   manager beside `APP_ENCRYPTION_KEY` (key + DB loss = working data lost — see below):

   ```sh
   openssl genrsa -out app-private.pem 2048
   openssl rsa -in app-private.pem -pubout -out app-public.pem
   ```

2. **Register the public key** (Queek side; the backend stores it under a `kid`):

   ```sh
   php artisan app:register --public-key=./app-public.pem
   ```

   Queek prints the app secret (`QUEEK_APP_SECRET`, verifies the handoff) and the key id
   (`APP_KEY_ID`, rides the JWT `kid` header). Configure the app with `APP_SLUG` (= `iss`),
   `APP_KEY_ID`, and `APP_PRIVATE_KEY` (the PEM — never logged, never shipped to clients).

3. **Acquire / cache / re-mint.** `acquireToken(installationId)` serves the cached token while
   its expiry is more than 5 minutes away; otherwise it signs an RS256 app JWT
   (`iss` = slug, `iat` = now − 60 s, `exp` = `iat` + 540 s, header `kid` — `node:crypto`
   only) and `POST`s `access_tokens`, then persists the token encrypted with its expiry and
   `kid` (one shared cache row per installation — restarts never burst). Concurrent callers
   in one process share one in-flight mint; two containers minting at once is harmless by
   design (Queek keeps coexisting tokens valid; a residual race self-heals via re-mint).
   Merchant refusal table (rev 7): any 401, or 403 `api_key_revoked` / `api_key_expired` /
   `invalid_client_key` → drop the token, re-mint once, retry once (a second refusal
   propagates); 403 `app_token_revoked` → drop ALL cached tokens and halt minting (kill
   switch / disabled app, no mint); every other 403 (scope, plan, mode) propagates to the
   caller without a mint.

4. **Failures follow the wire contract exactly** (`app-auth.ts` holds each code in one
   constant, confirmed against the backend build):
   - `401 invalid_client` — fatal for the app: loud log, minting stops, no retry loop.
   - `403 app_token_revoked` (kill switch / disabled app) — drops ALL cached tokens, stops
     minting, loud log. Minting resumes after the app is re-enabled + process restart
     (or `resumeMinting()`).
   - `404 app_installation_gone` — purges that installation locally.
   - `409 app_installation_pending` — the installation is not active yet: retry later
     with backoff, NEVER purge, NEVER halt. The row carries a persisted pending mark
     (store column, schema v2 — survives restarts, cleared when the installation is
     seen active or its mint succeeds).
   - `429 resync_cooldown` (per-installation resync only) — the ≤1/hour rotation
     cooldown: skipped + recorded, never retried. Any OTHER 429 is the per-app bucket
     (`too_many_requests`): `Retry-After` honored with jitter, bounded retries.
   - `5xx` — bounded exponential backoff.

5. **Resync after DB loss or a long outage.** `resyncFromQueek({ apiBase, tokens, store })`
   lists ACTIVE installations only (opaque keyset cursor — followed until `next_cursor`
   is null, never interpreted) → requests a resync per installation (409 pending →
   backoff + bounded retry, then skipped + recorded, never purged; 429 `resync_cooldown`
   → skipped + recorded, never retried; any other 429 → `Retry-After` + jitter, bounded
   retry; 404 `app_installation_gone` purges just that row and the run continues) → drops
   cached tokens → purges local rows absent from Queek's list, EXCEPT rows carrying the
   persisted pending mark — absence never purges a pending row, even across a restart.
   The fresh `webhook_secret` + non-secret settings arrive over the
   existing signed install channel — the install handler merges a redelivery for an
   existing installation idempotently (secret + settings refresh, `installedAt` and the
   cached token kept).

6. **Kill switch behaviour.** One backend operation revokes every token of an app across
   every store on the next request. The SDK side: cached tokens are dropped, minting halts
   with a loud log, and every call fails closed until the app is re-enabled and the
   process restarts (or resumes). Rotation without drama: add a `kid` (both verify) →
   switch the app to it → wait one token TTL → remove the old `kid`.

## Data rule + backups

The app database holds INSTALLATIONS ONLY (refs, token cache, webhook secrets, settings).
Business data lives in Queek. `resyncFromQueek` restores CONNECTIVITY with zero merchant
action — but app WORKING data (inbound tokens, order links, form tokens, app-side-only
settings) does NOT come back from resync: it needs the per-app `pg_dump` backup
(RPO ≤ 24 h) plus the `APP_ENCRYPTION_KEY` backup. Events missed beyond Queek's webhook
retries (~4 h) are gone; resync cannot backfill them. Full runbook: `docs/deploy.md` + O1.

## API surface

- **app-auth** (`app-auth.ts`): `loadAppCredential` (`APP_SLUG`/`APP_KEY_ID`/`APP_PRIVATE_KEY`,
  PEM validated at boot), `signAppJwt` (RS256, `iat` now − 60 s, `exp` window 540 s ≤ 600 s,
  `kid` header), the wire-contract error codes in one place (`INVALID_CLIENT_CODE`,
  `APP_TOKEN_REVOKED_CODE`, `APP_INSTALLATION_GONE_CODE`, `APP_INSTALLATION_PENDING_CODE`,
  `RESYNC_COOLDOWN_CODE`, `TOO_MANY_REQUESTS_CODE`), `AppMintHaltedError`.
- **tokens** (`tokens.ts`): `createAppTokenProvider({ credential, store, … })` —
  `acquireToken` (cache → sign → mint → persist), single-flight per installation, the exact
  contract error mapping (409 pending → backoff + bounded retry, marked, never purged);
  `createInstallationClient({ installationId, apiBase, tokens })` — the `QueekClient`
  every app call uses (re-mint once + retry once on token refusals only).
- **resync** (`resync.ts`): `resyncFromQueek({ apiBase, tokens, store })` — list active
  only (opaque keyset cursor) → resync each (409 pending → retry then skip + record;
  429 `resync_cooldown` → skip + record; other 429 → backoff + retry) → drop tokens →
  purge absent except known-pending. Connectivity scope only.
- **verify** (`signatures.ts`): `verifyQueekSignature` — Standard Webhooks verification (`webhook-id`, `webhook-timestamp`, `webhook-signature` over `{id}.{timestamp}.{body}`, keyed by the decoded `whsec_…` bytes), with timestamp-skew enforcement.
- **install handlers** (`install-handlers.ts`): `createInstallHandlers({ appSecret, store, onInstall?, onUninstall?, onSettings? })` — serves the signed install/uninstall/settings handoff. Defaults persist the installation (encrypted) in the store; a redelivered install for an existing installation merges idempotently (`saveResyncedInstallation`).
- **client** (`client.ts`): `createQueekClient({ apiBase, apiKey })` — the low-level typed fetch client over the Merchant API (`X-Client-Key`), with `Idempotency-Key` on writes, typed `QueekApiError`s, and 429 retry helpers. Types come from `openapi/merchant.json`, the committed snapshot of the live contract. Prefer `createInstallationClient` in apps.
- **webhooks** (`webhooks.ts`): `createWebhookHandler({ store, handlers })` — verifies each delivery against the installation's endpoint secret, dedupes on `webhook-id`, and dispatches `topic → handler` at most once.
- **store** (`store.ts`): `SqliteInstallationStore` (local/dev/test) and `PostgresInstallationStore`
  (`pg`, pool max 2, advisory-locked schema + `schema_version` row so two containers boot
  safely) — installations encrypted at rest (AES-GCM via `APP_ENCRYPTION_KEY`), plus the
  persisted 409-pending mark (`pending` column, schema v2, migrated in place) and the
  seen-webhook-id claim table behind dedupe. Pick with `createInstallationStore()`
  (`DATABASE_URL` set → Postgres, else SQLite — which production REFUSES with a clear
  message). Set once when the app is deployed; installs never change env: each install adds
  a row to the app's database, with that store's token + webhook secret encrypted using this key.
- **background** (`background.ts`): `detach` plus `runInstallationCatchup` — jittered
  per-installation cron (uniform 0–600 s start jitter, per-install error isolation,
  concurrency ≤ pool size, honors 429 once per installation).
- **logger** (`logger.ts`): redacts `sk_`/`pk_`/`whsec_`/`Bearer` values, bare RS256 JWTs, and
  PEM private-key blocks — the app JWT and private key can never reach logs.
- **session** (`session.ts`, server-only via `@usequeek/app-sdk/server`):
  `verifySessionToken` — HS256 dashboard session tokens minted per installation
  (`embsec_…` secret, raw UTF-8 key bytes, 20 s clock tolerance, slug audience
  + api_base issuer, full installation binding). The secret never enters a
  browser bundle: the main entry does not export the verifier.
- **frame** (`frame.ts`, browser-safe, no secret): `listenToDashboard`
  (accepts only the exact dashboard origin) and `sendReady` (exact target
  origin, never `"*"`).

## Embedded merchant page (S4 stage 2)

The dashboard frames your app's granted merchant page in a
`sandbox="allow-scripts allow-forms"` iframe and delivers the session token
by postMessage. Serve the page with a `frame-ancestors` policy naming ONLY
your dashboard origin, for example:

```http
Content-Security-Policy: frame-ancestors https://merchant.queek.com
```

Replace the host with the dashboard origin you registered. `frame-ancestors`
is a docs-only control the dashboard cannot enforce for you: without it any
site may frame the page, and the token handshake (origin-bound) is your only
remaining gate. Verify every token server-side with `verifySessionToken`
before trusting calls that carry one.

## Local development

Point the client at a local backend with `QUEEK_DEV_API_HOSTS` (comma-separated hosts). It is refused when `NODE_ENV=production`, so it can never weaken a live app. See `devApiHostsFromEnv` in `client.ts`.

Postgres locally: any Postgres works — point `DATABASE_URL` at it and the pg suite runs
(CI always runs it via a service container); without `DATABASE_URL` those tests skip cleanly.

## Registration

App registration is by the Queek team today: you ship Queek your manifest URL and receive the app secret + store key. There is no public self-serve registration yet.

## License

MIT — see [LICENSE](./LICENSE).
