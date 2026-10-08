# @usequeek/app-sdk

The SDK for building a Queek app on the public Merchant API and signed webhooks. Framework-agnostic Web-standard handlers for the install handoff and topic webhooks (`Request` in, `Response` out — use them from Next.js route handlers, Express, or any runtime), a typed Merchant API client (types generated from the live contract), GitHub-style app credentials (one asymmetric key per app, short-lived per-installation tokens minted on demand), resync recovery, and an encrypted installation store (SQLite for local/test, Postgres in production). Optional Hono wrappers live under `@usequeek/app-sdk/hono`.

Full guide: <https://docs.usequeek.com/docs/apps/sdk>.

> Pre-1.0: the API can still change; pin the exact version (`npm i @usequeek/app-sdk@<version>`).

```sh
npm i @usequeek/app-sdk pg
```

Requires Node `>=22.14`. `pg` is a regular dependency (the production store). `hono` is an optional peer — install it (`npm i hono`) only if you use the Hono wrappers.

## Quick start for AI agents

Register the app on the Queek Developer page, then use the CLI:

1. Scaffold: `npm create @usequeek/app my-app` (same as `queek app init`).
2. Develop: `queek app dev` — tunnel + dev-store install; mints credentials into `.queek/.env.local` on first run.
3. Deploy: `queek app deploy` — pushes `queek.app.toml` as a new version (secret shown once, also written to `.queek/.env.local`). In CI, authenticate with a per-app App Automation Token from the Developer page (`QUEEK_APP_AUTOMATION_TOKEN`).
4. Import from the entry table below: `@usequeek/app-sdk` for server code, `@usequeek/app-sdk/browser` (or `/react`) for browser code — never the main entry in a browser bundle.
5. Serve the install/uninstall/settings handoff (`handleInstallRequest`) and topic webhooks (`handleWebhookRequest`), then call the Merchant API via `createInstallationClient`.
6. Capabilities: the live list of scopes, webhook topics and other platform capabilities is served at `https://api.usequeek.com/docs/capabilities.json`; bridge capabilities are in the `queek-bridge` skill of [queek-ai-toolkit](https://github.com/usequeek/queek-ai-toolkit) (`references/bridge-spec.md`). Confirm scope and topic names with `queek app deploy`'s validator rather than a baked-in list.

## Which entry do I import?

| Import | For | Pulls in |
| --- | --- | --- |
| `@usequeek/app-sdk` (main) | Server / universal code: handlers, client, stores, verifiers | `node:crypto`, `pg` — NOT browser-bundlable |
| `@usequeek/app-sdk/server` | Session-token verifier (`verifySessionToken`) | Server-only (`jose`) — never import in a browser bundle |
| `@usequeek/app-sdk/hono` | Thin Hono wrappers (`hono` optional peer) | Server-only |
| `@usequeek/app-sdk/react` | React apps (`<QueekProvider>`, `useQueek()`; `react` optional peer) | Browser-safe (built on the same bridge modules as `/browser`) |
| `@usequeek/app-sdk/browser` | Plain-browser code: `installAuthFetch` + bridge/theme helpers, no framework | Browser-safe ONLY |

Browser rule of thumb: if the code ships to the browser and does not need React, import it from `@usequeek/app-sdk/browser`. `installAuthFetch` is a browser-safe MODULE, but it is not browser-safe FROM THE MAIN ENTRY — the main barrel re-exports server modules (`app-auth` → `node:crypto`, `store` → `pg`), so a bundler resolving `installAuthFetch` from `@usequeek/app-sdk` still parses those Node-only files and fails (Vite/Rollup builds break).

## Example (any framework)

A minimal app with plain Web-standard handlers — no framework import:

```ts
import {
  createAppTokenProvider,
  handleInstallRequest,
  handleWebhookRequest,
  loadAppCredential,
  SqliteInstallationStore,
} from "@usequeek/app-sdk";

const store = new SqliteInstallationStore({
  path: "./data/installations.db",
  storeKey: process.env.APP_ENCRYPTION_KEY!,
});
const tokens = createAppTokenProvider({
  credential: loadAppCredential({ appSlug: "hello" }), // APP_SLUG/APP_KEY_ID/APP_PRIVATE_KEY (base64 of the PEM, one line)
  store,
});
const installOptions = { appSecret: process.env.QUEEK_APP_SECRET!, store };
const webhookOptions = {
  store,
  handlers: {
    "orders/updated": async (envelope, context) => {
      console.log("order update:", context.installation.storePid, envelope.data);
    },
  },
};
```

Next.js App Router — one route file per handoff path (`handleInstallRequest` routes on the request URL's trailing `install` / `uninstall` / `settings` segment, so one shared options object serves all three):

```ts
// app/api/install/route.ts (and uninstall/route.ts, settings/route.ts likewise)
import { installOptions } from "./options";

export async function POST(request: Request) {
  return handleInstallRequest(request, installOptions);
}

// app/api/webhooks/route.ts
import { webhookOptions } from "./options";

export async function POST(request: Request) {
  return handleWebhookRequest(request, webhookOptions);
}
```

### Express (no new package)

Express hands you whatever request object it supports — pass its raw body bytes and headers straight to the layer-1 core (no `Request` construction needed). Keep the untouched bytes Queek signed with the built-in `express.raw` parser:

```ts
import express from "express";
import {
  type DeliveryResult,
  handleInstallDelivery,
  handleWebhookDelivery,
} from "@usequeek/app-sdk";

const app = express();
app.use("/api", express.raw({ type: "application/json" }));

function reply(res: express.Response, result: DeliveryResult) {
  res.status(result.status).json(result.body);
}

for (const route of ["install", "uninstall", "settings"]) {
  app.post(`/api/${route}`, async (req, res) => {
    reply(
      res,
      await handleInstallDelivery(
        { rawBody: req.body as Buffer, headers: req.headers, method: req.method, path: req.path },
        installOptions,
      ),
    );
  });
}
app.post("/api/webhooks", async (req, res) => {
  reply(
    res,
    await handleWebhookDelivery({ rawBody: req.body as Buffer, headers: req.headers }, webhookOptions),
  );
});
```

### Fastify (no new package)

Same idea — keep the body raw with `addContentTypeParser`, then call the core directly:

```ts
import Fastify from "fastify";
import { handleWebhookDelivery } from "@usequeek/app-sdk";

const fastify = Fastify();
fastify.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
  done(null, body);
});

fastify.post("/api/webhooks", async (req, reply) => {
  const result = await handleWebhookDelivery(
    { rawBody: req.body as Buffer, headers: req.headers },
    webhookOptions,
  );
  return reply.status(result.status).send(result.body);
});
```

### Why the raw body matters

Signature verification covers the exact bytes Queek sent (`{id}.{timestamp}.{body}`, as defined by the [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) spec), not the parsed JSON value — so the SDK takes the untouched body bytes at every layer. A parsed-then-restringified body has different bytes (spacing, key order) and will NOT verify. A string `rawBody` is used verbatim, so only pass a string when it is already the exact UTF-8 text — otherwise prefer `Buffer`/`Uint8Array` straight from `express.raw`, Fastify's `parseAs: "buffer"`, or `await request.arrayBuffer()`. In practice: Express needs `express.raw(...)` (never `express.json()`) on webhook routes, Fastify needs `addContentTypeParser` with `parseAs: "buffer"`, and in Next.js you read `await request.arrayBuffer()` (the SDK's layer 2 already does) rather than `await request.json()`.

### Body-size posture

The SDK itself imposes no maximum body size (`arrayBuffer` / `TextDecoder` / `JSON.parse` are unbounded) — the cap belongs to the framework parser in front of it, which already rejects oversized bodies before the SDK ever sees them. Queek deliveries are small JSON payloads, so the framework defaults are plenty; if you set them explicitly, `express.raw({ type: "application/json", limit: "1mb" })` and Fastify's default `bodyLimit` of 1 MiB are the recommended ceilings. The SDK has no body-size option.

### Hono

Prefer Hono? The thin wrappers under `@usequeek/app-sdk/hono` (same options, same behaviour, same errors/status codes) mount the same core. (If you already run Hono on Node, `@hono/node-server`'s `getRequestListener` bridges serving for you.)

```ts
import { SqliteInstallationStore } from "@usequeek/app-sdk";
import { createInstallHandlers, createWebhookHandler } from "@usequeek/app-sdk/hono";
import { Hono } from "hono";

const store = new SqliteInstallationStore({
  path: "./data/installations.db",
  storeKey: process.env.APP_ENCRYPTION_KEY!,
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

## Credential lifecycle (GitHub-style installation tokens)

One asymmetric credential per app — no per-installation secrets cross the handoff.

1. **Keypair — two paths.** (a) Offline: generate locally, then upload the PUBLIC key on
   the Developer page (Keys) — Queek never receives the private key:

   ```sh
   openssl genrsa -out app-private.pem 2048
   openssl rsa -in app-private.pem -pubout -out app-public.pem
   ```

   (b) Faster: `queek app dev` server-generates the pair and stores the kid + private key
   (base64, one line) in `.queek/.env.local` (gitignored, 0600) — the private key is
   returned once and never shown again; if lost, generate a new key. Either way, keep the
   private key in your secrets manager beside `APP_ENCRYPTION_KEY` (key + DB loss = working
   data lost — see below).

2. **Register the app** on the Queek Developer page, then configure five values — each from
   exactly one place: `APP_SLUG` is the slug in `queek.app.toml` (= JWT `iss`); `APP_KEY_ID`
   is the kid from Keys (returned by generate/upload, or written by `queek app dev`);
   `APP_PRIVATE_KEY` is the matching private key (your offline file, or the once-shown
   server-generated one; raw PEM also accepted — never logged, never shipped to clients);
   `QUEEK_APP_SECRET` verifies the handoff (shown once on first registration — `queek app
   deploy` appends it to `.queek/.env.local`; `queek app dev` fetches it there; or Reveal
   it on the dashboard) and is never rotated by dev; `APP_ENCRYPTION_KEY` is 32 local
   random bytes, base64 or hex (`queek app dev` mints one into `.queek/.env.local`).

3. **Acquire / cache / re-mint.** `acquireToken(installationId)` serves the cached token while
   its expiry is more than 5 minutes away; otherwise it signs an RS256 app JWT
   (`iss` = slug, `iat` = now − 60 s, `exp` = `iat` + 540 s, header `kid` — `node:crypto`
   only) and `POST`s `access_tokens`, then persists the token encrypted with its expiry and
   `kid` (one shared cache row per installation — restarts never burst). Concurrent callers
   in one process share one in-flight mint; two containers minting at once is harmless by
   design (Queek keeps coexisting tokens valid; a residual race self-heals via re-mint).
   Token refusals: any 401, or 403 `api_key_revoked` / `api_key_expired` /
   `invalid_client_key` → drop the token, re-mint once, retry once (a second refusal
   propagates); 403 `app_token_revoked` → drop ALL cached tokens and halt minting (kill
   switch / disabled app, no mint); every other 403 (scope, plan, mode) propagates to the
   caller without a mint.

4. **Failures are handled by status and code** (`app-auth.ts` holds each code in one
   constant):
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

6. **Kill switch behaviour.** One operation on Queek's side (the kill switch) revokes every
   token of an app across every store on the next request. The SDK side is the
   `app_token_revoked` row of item 4: every call fails closed until the app is re-enabled
   and the process restarts (or resumes). Key rotation: add a `kid` (both verify) →
   switch the app to it → wait one token TTL → remove the old `kid`.

## Data rule + backups

The app database holds INSTALLATIONS ONLY (refs, token cache, webhook secrets, settings).
Business data lives in Queek. `resyncFromQueek` restores CONNECTIVITY with zero merchant
action — but app WORKING data (inbound tokens, order links, form tokens, app-side-only
settings) does NOT come back from resync: it needs the per-app `pg_dump` backup
(RPO ≤ 24 h) plus the `APP_ENCRYPTION_KEY` backup. Events missed beyond Queek's webhook
retries (~4 h) are gone; resync cannot backfill them. Deploy reference: `queek app deploy --help`.

## Data deletion

Treat the uninstall handoff (`app/uninstalled`) as the deletion trigger: the default
`onUninstall` already deletes the installation row (secrets, token cache, settings) —
keep that delete when you override it, and purge any app-side working data keyed by the
installation there too.

Unknown topics answer 200 without running a handler (forward compatibility, not consent):
that 200 must not swallow a future privacy topic. If Queek ships mandatory privacy
topics, register explicit handlers for them — an unhandled topic only reports
`unhandled: true`, it deletes nothing.

## Storefront app-proxy (signed reads)

Queek signs each storefront proxy fetch with the installation's `proxy_secret`;
verify before answering the shopper:

```ts
import { handleProxyRequest } from "@usequeek/app-sdk";

export async function GET(request: Request) {
  return handleProxyRequest(
    request,
    { store, path: "/apps/booking/availability" }, // Queek-side canonical path, not the local route
    ({ installation, params }) =>
      Response.json({ slots: slotsFor(params.date, installation.storePid) }),
  );
}
```

The canonical string is `path + "\n" + shop + "\n" + ts + "\n" + sorted(k=v&...)`
(`sig` excluded), hex HMAC-SHA256 over the FULL `whsec_…` string — no base64 decode
step. `kid` routes to the installation whose `proxy_secret` verifies (previous-secret
grace: pass every active secret to `verifyProxyQuery`); timestamps skew at most 5
minutes, each `jti` is single-use, and only `GET` is served (proxy reads are read-only).
Hono: mount `createProxyHandler({ store, path, onVerified })` from
`@usequeek/app-sdk/hono`.

## API surface

- **app-auth** (`app-auth.ts`): `loadAppCredential` (`APP_SLUG`/`APP_KEY_ID`/`APP_PRIVATE_KEY`
  — base64 of the PEM, raw PEM, or `\n`-escaped one-line PEM; RSA validated at boot),
  `signAppJwt` (RS256, `iat` now − 60 s, `exp` window 540 s ≤ 600 s,
  `kid` header), the error codes in one place (`INVALID_CLIENT_CODE`,
  `APP_TOKEN_REVOKED_CODE`, `APP_INSTALLATION_GONE_CODE`, `APP_INSTALLATION_PENDING_CODE`,
  `RESYNC_COOLDOWN_CODE`, `TOO_MANY_REQUESTS_CODE`), `AppMintHaltedError`.
- **tokens** (`tokens.ts`): `createAppTokenProvider({ credential, store, … })` —
  `acquireToken` (cache → sign → mint → persist), single-flight per installation, with the
  error handling in Credential lifecycle items 3–4;
  `createInstallationClient({ installationId, apiBase, tokens })` — the `QueekClient`
  every app call uses (re-mint once + retry once on token refusals only).
- **resync** (`resync.ts`): `resyncFromQueek({ apiBase, tokens, store })` — the flow in
  Credential lifecycle item 5. Connectivity scope only.
- **verify** (`signatures.ts`): `verifyQueekSignature` — Standard Webhooks verification (`webhook-id`, `webhook-timestamp`, `webhook-signature` over `{id}.{timestamp}.{body}`, keyed by the decoded `whsec_…` bytes), with timestamp-skew enforcement.
- **delivery core** (`delivery.ts`): `CoreDelivery` (`rawBody` + `headers`) / `InstallDelivery` (+ `method`/`path`) / `DeliveryResult` (`{ status, body }`) / `CoreHeaders`, plus `readHeader` (case-insensitive, array-tolerant), `decodeBody`, and `toResponse`. Zero request/response types.
- **install handlers** (`install-handlers.ts`): layer 1 `handleInstallDelivery(input, { appSecret, store, onInstall?, onUninstall?, onSettings? })` serves the signed install/uninstall/settings handoff from raw bytes + headers (routes on the path's trailing segment); layer 2 `handleInstallRequest(request, …)` adapts `Request` → `Response` onto it. Defaults persist the installation (encrypted) in the store; a redelivered install for an existing installation merges idempotently (`saveResyncedInstallation`). The Hono wrapper `createInstallHandlers` lives under `@usequeek/app-sdk/hono` (`hono.ts`).
- **client** (`client.ts`): `createQueekClient({ apiBase, apiKey })` — the low-level typed fetch client over the Merchant API (`X-Client-Key`), with `Idempotency-Key` on writes, typed `QueekApiError`s, and 429 retry helpers. Both it and `createInstallationClient({ installationId, apiBase, tokens })` are generic (`<AppPaths>`, default: the bundled `merchant-schema.ts` compat shim): pass the app's own codegen output for current types without waiting for an SDK release. The default does NOT auto-update (re-run codegen in the app; sunset signal at 1.0). `openapi/merchant.json` stays in-repo as `gen:merchant`'s reference input and is not shipped in the published package. Prefer `createInstallationClient` in apps.
- **webhooks** (`webhooks.ts`): layer 1 `handleWebhookDelivery(input, { store, handlers })` verifies each delivery against the installation's endpoint secret, dedupes on `webhook-id`, and dispatches `topic → handler` at most once; layer 2 `handleWebhookRequest(request, …)` adapts `Request` → `Response` onto it. The Hono wrapper `createWebhookHandler` lives under `@usequeek/app-sdk/hono` (`hono.ts`). Unknown topics answer 200 `unhandled` — see Data deletion before relying on that.
- **proxy** (`proxy.ts`): `verifyProxyQuery` / `verifyProxyQueryDetailed` — app-proxy query verification byte-exact with Queek's signer (`path\nshop\nts\nsorted(k=v&...)`, hex HMAC-SHA256 over the FULL `whsec_…` string, 5-minute skew floored at 60 s, `timingSafeEqual`, previous-secret grace over the secrets list); layer 1 `verifyProxyDelivery(input, { store, … })` resolves the installation from the store by `kid` and claims single-use `jti`; layer 2 `handleProxyRequest(request, { store, path, … }, onVerified)` serves GET only. The Hono wrapper `createProxyHandler` lives under `@usequeek/app-sdk/hono` (`hono.ts`).
- **store** (`store.ts`): `SqliteInstallationStore` (local/dev/test) and `PostgresInstallationStore`
  (`pg`, pool max 2, advisory-locked schema + `schema_version` row so two containers boot
  safely) — installations encrypted at rest (AES-GCM via `APP_ENCRYPTION_KEY`), plus the
  persisted 409-pending mark (`pending` column, schema v2, migrated in place) and the
  seen-webhook-id claim table behind dedupe. Pick with `createInstallationStore()`
  (`DATABASE_URL` set → Postgres, else SQLite — which production REFUSES with a clear
  message). `APP_ENCRYPTION_KEY` is set once when the app is deployed; installs never change env:
  each install adds a row to the app's database, with that store's token + webhook secret
  encrypted using this key.
- **background** (`background.ts`): `detach` plus `runInstallationCatchup` — jittered
  per-installation cron (uniform 0–600 s start jitter, per-install error isolation,
  concurrency ≤ pool size, honors 429 once per installation).
- **logger** (`logger.ts`): redacts `sk_`/`pk_`/`whsec_`/`Bearer` values, bare RS256 JWTs, and
  PEM private-key blocks — the app JWT and private key can never reach logs.
- **session** (`session.ts`, server-only via `@usequeek/app-sdk/server`):
  `verifySessionToken` — HS256 dashboard session tokens minted per installation
  (`embsec_…` secret, raw UTF-8 key bytes, 20 s clock tolerance, slug audience,
  issuer = the handoff `apiBase` verbatim (`installation.apiBase` — it equals the
  bare `app.url` Queek signs as `iss`), full installation binding). There is one token
  type: the dashboard puts the same token in the first-load URL param
  (`queek_token`, stripped on arrival) and answers bridge `ready` requests with it,
  so first-load and refresh tokens are verified by this one verifier — no purpose
  split, extra claims are ignored. The secret never enters a
  browser bundle: the main entry does not export the verifier. The install
  and resync handoffs deliver `embed_secret` + `app_id`; the store keeps
  them on the installation (`embedSecret` encrypted, `appId`), and
  `sessionTokenInstallationId` reads the token's `installation_id` as an
  unverified routing hint so a server can load that row before verifying.
- **frame** (`frame.ts`, browser-safe, no secret): the embedded-app bridge
  v1 — typed unions both directions (`ready{capabilities,sdkVersion}`,
  `theme`, `title`/`title-action`, `toast`, `save-bar`/`save-bar-action`,
  `navigate`/`navigated`, `open`, `pick-resource`/`resource-picked`/
  `resource-pick-cancelled`), unknown types ignored, every outbound string
  length-capped client-side. `listenToDashboard` (accepts only the exact
  dashboard origin, plus an `expectSource` window check) and typed senders
  (`sendReady`, `sendToast`, `sendSaveBar`, `sendTitle`, `sendNavigated`,
  `sendOpen`, `sendPickResource`, …) to the exact target origin, never `"*"`.
  `parseOutboundMessage` runs the same per-type validation the dashboard
  runs — the dashboard re-validates everything before acting (open targets,
  title/toast/pick content), so a compromised frame cannot smuggle
  `javascript:` URLs or uncapped strings through the bridge. `open` targets
  are a dashboard-relative path or an absolute `https:` URL; backslashes,
  control characters, protocol-relative URLs and every other scheme are
  refused (by `clipOutbound` as well as `isAllowedOpenTarget`).

  **Bridge handshake.** The app announces `ready{capabilities,sdkVersion}`;
  the dashboard answers with its `theme` message, which also declares the
  DASHBOARD's capabilities: `{ type: "theme", mode, locale?, capabilities?:
  string[], bridge?: "1" }` (same caps as outbound: at most 32 entries of 64
  characters). `listenToDashboard` exposes both on the `BridgeTheme` passed to
  `onTheme`. A dashboard that omits `capabilities` is legacy (ready/token/
  resize only). `<QueekProvider>` stores the declared set: `pickResource`
  rejects at once when it lacks `pick-resource`, waits up to 1.5 s after
  `ready` when the set is still unknown, and rejects if no handshake arrives.
  Each pick carries a `requestId` (on `pick-resource`); a dashboard that
  declares `pick-resource` MUST echo it on `resource-picked` / `resource-pick-cancelled` — answers with a
  different or missing id are dropped as stale.
- **auth** (`auth-fetch.ts`, no secret — browser-safe as a module, but import it
  from `@usequeek/app-sdk/browser` in browser bundles, never from the main
  entry): `installAuthFetch({ exchange })`
  — reads the dashboard token (`queek_token` query param) from the first
  load, strips it with `history.replaceState`, exchanges it once for the
  app's own session, attaches `Authorization: Bearer <session>` to
  same-origin fetch (cookies stay out), and re-establishes via the bridge
  `ready→token` flow + one retry on 401. Session recovery runs only when framed (a post target other than the
  window itself) and is not retried per request after a failed attempt — only
  after a later dashboard token arrives. Pass the same `capabilities`/
  `sdkVersion` as the provider so its refresh `ready` announces one consistent set. The app's
  token-exchange endpoint receives the first-load token and every 401-refresh
  token through the same `exchange` callback, so it verifies both with the
  single `verifySessionToken` verifier:

  ```ts
  import { verifySessionTokenDetailed } from "@usequeek/app-sdk/server";

  async function exchange(token: string): Promise<string> {
    const options = { secret: installation.embedSecret!, audience: "my-app", issuer: installation.apiBase, expected };
    const checked = await verifySessionTokenDetailed(token, options);
    if (!checked.ok) throw Object.assign(new Error("unauthorized"), { status: 401 });
    return mintAppSession(checked.claims);
  }
  ```
- **theme** (`theme.ts`, browser-safe, no secret): `applyTheme(mode)` toggles
  `.dark` on `<html>` + `color-scheme` (shadcn's dark-mode mechanism);
  `themeBootstrapScript()` returns the inline `<head>` snippet that reads the
  unsigned `theme` URL param before first paint (no flash — a first-paint hint
  only, validated to `light`|`dark`, overwritten by the live bridge message);
  `installThemeListener` follows live bridge `theme{mode}` messages (only from
  `window.parent` by default; pass `expectSource` to override). The live mode is
  remembered in `sessionStorage`, and the bootstrap script falls back to it when
  the URL carries no `theme` param, so an in-frame reload never flashes light. Every live `theme` message also
  rewrites the `theme` URL param (other params kept) so a stale first-load param
  never beats the current mode on reload, and the first-load mode is remembered
  too (a legacy dashboard that never sends `theme` still reloads flash-free).
- **react** (`react.ts`, via `@usequeek/app-sdk/react` — `react` is an
  optional peer, same pattern as `./hono`): `<QueekProvider>` owns one
  bridge subscription; `useQueek()` returns `{ toast, saveBar, title,
  navigate, pickResource, theme }` over the framework-free core.
- **scopes** (`scopes.ts`): `createInstallationScopesClient({ installationId, store, signJwt, … })`
  — the optional-scopes session, wired to the same store + token provider as the
  installation client. `queryScopes` reads the cached grant (no network);
  `requestScopes` builds the dashboard consent link (pure — the SDK never
  renders consent); `revokeScopes` posts the app-authenticated revoke and
  refreshes the cache. The install/settings handlers accept the signed
  `app/scopes_update` handoff on both routes and refresh the cached grant
  (dropping the cached token when it moved).

## Scopes

Apps declare required scopes (granted at install) plus optional scopes
(requested later, revocable). The per-installation session covers the app side:

```ts
import { createInstallationScopesClient } from "@usequeek/app-sdk";

const scopes = createInstallationScopesClient({
  installationId,
  store,
  signJwt: () => provider.signJwt(),
  appSlug: "my-app",
  optionalScopes: ["merchant-orders-read"], // the app's own manifest knowledge
});

await scopes.queryScopes(); // { granted, optional } — cached, no network
scopes.requestScopes(["merchant-orders-read"]); // dashboard consent link (open via sendOpen)
await scopes.revokeScopes(["merchant-orders-read"]); // 422 app_scope_required → AppScopeRequiredError
```

`queryScopes` splits the cached effective grant against the declared-optional
list you pass (the app surface exposes the grant but no declared list, so the
split needs your manifest knowledge). `requestScopes` returns
`/apps?app={slug}&view=scopes&scopes={a},{b}` (absolute under
`dashboardOrigin` when configured) — open it via `sendOpen` or a redirect: it
opens the merchant's consent screen in the dashboard (requires a dashboard that
supports the consent screen). The link carries the slug + the scope list only; the dashboard
resolves the installation from the signed-in store. The grant reaches you as a
signed `app/scopes_update` handoff, which the install/settings handlers apply
like a resync (same verifier, same replay claim): cached grant refreshed,
cached token dropped only when the grant moved.

## Embedded merchant page

The dashboard frames your app's granted merchant page in a
`sandbox="allow-scripts allow-forms"` iframe and delivers the session token
by postMessage. Serve the page with a `frame-ancestors` policy naming ONLY
your dashboard origin, for example:

```http
Content-Security-Policy: frame-ancestors https://dashboard.usequeek.com
```

Replace the host with the dashboard origin you registered. `frame-ancestors`
is a header only your server can set, so the dashboard cannot enforce it for you:
without it any site may frame the page, and the token handshake (origin-bound) is
your only remaining gate. Verify every token server-side before trusting calls that carry one
(see the `auth` entry under API surface).

## Local development

Point the client at a local Queek API with `QUEEK_DEV_API_HOSTS` (comma-separated hosts). It is refused when `NODE_ENV=production`, so it can never weaken a live app. See `devApiHostsFromEnv` in `client.ts`.

Postgres locally: any Postgres works — point `DATABASE_URL` at it and the pg suite runs
(CI always runs it via a service container); without `DATABASE_URL` those tests skip cleanly.

## License

MIT — see [LICENSE](./LICENSE).
