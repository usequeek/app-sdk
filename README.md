# @usequeek/app-sdk

The SDK for building an app that installs into Queek stores. It verifies the signed install handoff and topic webhooks, mints and caches installation tokens, calls the Merchant API through a typed client, and keeps installations in an encrypted store.

Full guide: <https://docs.usequeek.com/docs/apps/sdk>. Merchant API reference: <https://api.usequeek.com/docs/merchant.json>.

> Pre-1.0. The API can still change between minor versions. Pin the exact version and read [CHANGELOG.md](./CHANGELOG.md) before you upgrade.

## Requirements

- Node.js 22.14 or later.
- `hono` (optional): only for the wrappers in `@usequeek/app-sdk/hono`.
- `react` 18 or 19 (optional): only for `@usequeek/app-sdk/react`.

## Install

```sh
npm i @usequeek/app-sdk
```

`pg` ships as a regular dependency because Postgres is the production store.

To start from a working project, run `npm create @usequeek/app my-app` (the same as `queek app init`), then `queek app dev` for a tunnel, a dev-store install, and credentials written to `.queek/.env.local`. `queek app deploy` pushes `queek.app.toml`. For the live list of scopes and webhook topics, read <https://api.usequeek.com/docs/capabilities.json>.

## Quick start

A complete server with plain Web-standard handlers. It has no framework import.

```ts
import {
  createAppTokenProvider,
  createInstallationClient,
  handleInstallRequest,
  handleWebhookRequest,
  type InstallHandlerOptions,
  loadAppCredential,
  SqliteInstallationStore,
  type WebhookHandlerOptions,
} from "@usequeek/app-sdk";

const store = new SqliteInstallationStore({
  path: "./data/installations.db",
  storeKey: process.env.APP_ENCRYPTION_KEY ?? "",
});

// Reads APP_SLUG, APP_KEY_ID and APP_PRIVATE_KEY from the environment.
const tokens = createAppTokenProvider({ credential: loadAppCredential(), store });

const installOptions: InstallHandlerOptions = {
  appSecret: process.env.QUEEK_APP_SECRET ?? "",
  store,
};

const webhookOptions: WebhookHandlerOptions = {
  store,
  handlers: {
    "orders/updated": async (envelope, { installation }) => {
      const client = createInstallationClient({
        installationId: installation.installationId,
        apiBase: installation.apiBase,
        tokens,
      });
      const order = await client.request("GET", "/orders/ord_123");
      console.log("order changed", installation.storePid, envelope.data, order);
    },
  },
};

// One route file per handoff path. The handler routes on the trailing
// `install`, `uninstall` or `settings` segment of the URL.
export const installRoute = (request: Request) => handleInstallRequest(request, installOptions);
export const webhookRoute = (request: Request) => handleWebhookRequest(request, webhookOptions);
```

In Next.js App Router, export `installRoute` as `POST` from `app/api/install/route.ts` (and again from `uninstall/route.ts` and `settings/route.ts`), and `webhookRoute` as `POST` from `app/api/webhooks/route.ts`.

## Which entry do I import?

| Import | For | Notes |
| --- | --- | --- |
| `@usequeek/app-sdk` | Server code: handlers, clients, stores, verifiers | Uses `node:crypto` and `pg`. Not browser-bundlable. |
| `@usequeek/app-sdk/server` | `verifySessionToken` | Server only (uses `jose`). Needs the embed secret, which must never reach a browser. |
| `@usequeek/app-sdk/hono` | Hono wrappers | Server only. Needs the `hono` peer. |
| `@usequeek/app-sdk/react` | `<QueekProvider>` and `useQueek()` | Browser-safe. Needs the `react` peer. |
| `@usequeek/app-sdk/browser` | `installAuthFetch`, the bridge and theme helpers | Browser-safe. No framework. |

Import browser code that does not need React from `@usequeek/app-sdk/browser`. The main entry re-exports server modules, so a bundler that resolves `installAuthFetch` from it fails on `node:crypto` and `pg`. A test in this repository walks the imports of `/browser` and fails if a Node-only module ever appears in them.

## Receive deliveries

Queek sends two kinds of signed `POST`:

- **The install handoff** (`install`, `uninstall`, `settings`, plus the `app/resync` and `app/scopes_update` events on the same routes). It is signed with your app secret (`whsec_…`).
- **Topic webhooks** (for example `orders/updated`). Each installation has its own endpoint secret, delivered once inside the install payload.

Both use the Standard Webhooks headers `webhook-id`, `webhook-timestamp` and `webhook-signature`, over `{id}.{timestamp}.{raw body}`, with a 5-minute timestamp window. Every handler checks the signature, rejects stale timestamps, claims the `webhook-id` so each delivery runs at most once, and then calls your code.

The handlers come in three layers that behave identically:

1. `handleInstallDelivery(input, options)` and `handleWebhookDelivery(input, options)` take raw body bytes plus headers and return `{ status, body }`. They use no request or response types, so any framework works.
2. `handleInstallRequest(request, options)` and `handleWebhookRequest(request, options)` adapt a Web `Request` to a `Response`.
3. `createInstallHandlers`, `createWebhookHandler` and `createProxyHandler` from `@usequeek/app-sdk/hono`.

### Status codes

| Route | Status | Meaning |
| --- | --- | --- |
| Install handoff | 200 | Handled. |
| | 400 | The body is not the expected envelope or payload. |
| | 401 | Missing signature header, stale timestamp, or bad signature. |
| | 404 | Unknown route or unknown installation. |
| | 405 | Not a `POST`. |
| | 409 | This `webhook-id` was already claimed. |
| | 500 | Your callback or the store write threw. The claim is released, so Queek's retry can land. |
| Topic webhook | 200 | Handled, a repeat (`deduped: true`), or a topic with no handler (`unhandled: true`). |
| | 400 | The body is not a JSON envelope with a `topic`. |
| | 401 | Missing header, unknown installation, stale timestamp, or bad signature. |
| | 500 | Your handler threw. The claim is released, so Queek's retry can land. |

Answer 2xx only after your data is stored. Anything else makes Queek retry.

### When your code throws

A throwing callback answers 500 and releases the claim. The SDK also reports the error: pass `onError(error, { stage, eventId, topic })` in the handler options to send it to your own monitoring. Without `onError`, the SDK writes the error name and message to stderr with secrets redacted. A throwing `onError` never changes the response.

### Why the raw body matters

The signature covers the exact bytes Queek sent, not the parsed JSON. A body that was parsed and serialised again has different bytes and will not verify. Pass `Buffer` or `Uint8Array` straight from the framework. A string `rawBody` is used as given, so pass one only when it is already the exact UTF-8 text.

### Express

Use `express.raw`, never `express.json()`, on these routes:

```ts
import express from "express";
import {
  type DeliveryResult,
  handleInstallDelivery,
  handleWebhookDelivery,
  type InstallHandlerOptions,
  type WebhookHandlerOptions,
} from "@usequeek/app-sdk";

declare const installOptions: InstallHandlerOptions;
declare const webhookOptions: WebhookHandlerOptions;

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
  reply(res, await handleWebhookDelivery({ rawBody: req.body as Buffer, headers: req.headers }, webhookOptions));
});
```

### Fastify

Keep the body as a buffer with `addContentTypeParser`:

```ts
import Fastify from "fastify";
import { handleWebhookDelivery, type WebhookHandlerOptions } from "@usequeek/app-sdk";

declare const webhookOptions: WebhookHandlerOptions;

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

### Hono

```ts
import { SqliteInstallationStore } from "@usequeek/app-sdk";
import { createInstallHandlers, createWebhookHandler } from "@usequeek/app-sdk/hono";
import { Hono } from "hono";

const store = new SqliteInstallationStore({
  path: "./data/installations.db",
  storeKey: process.env.APP_ENCRYPTION_KEY ?? "",
});

const app = new Hono();
app.route("/", createInstallHandlers({ appSecret: process.env.QUEEK_APP_SECRET ?? "", store }));
app.route(
  "/webhooks",
  createWebhookHandler({
    store,
    handlers: {
      "orders/updated": async (envelope, { installation }) => {
        console.log("order changed", installation.storePid, envelope.data);
      },
    },
  }),
);

export default app;
```

### Body size

The SDK sets no body-size limit. Set it in the framework parser in front of it. Queek deliveries are small, so the framework defaults are enough. If you set a limit, 1 MiB is plenty.

## Call the Merchant API

`createInstallationClient({ installationId, apiBase, tokens })` is the client apps use. On each call it gets the installation token from `acquireToken()` (usually a cache hit) and sends it as `X-Client-Key`. If Queek refuses the token, the client drops it, mints a new one, and retries once. A second refusal reaches you.

```ts
import { createInstallationClient } from "@usequeek/app-sdk";

// installationId and apiBase come from the install record; tokens is the provider from the quick start.
const client = createInstallationClient({ installationId, apiBase, tokens });

const storeProfile = await client.getStore();
const accepted = await client.request("POST", "/orders/ord_123/status", {
  body: { status: "accept" }, // needs the merchant-orders-status-update scope
});
```

`createQueekClient({ apiBase, apiKey })` is the same client for one fixed key.

`apiBase` is validated when the client is created. It must be `https`, carry no credentials, and name a host on the allowlist (`api.usequeek.com` by default), so a tampered handoff can never send your key to another host. To allow a test host, pass `allowedApiHosts` or set `QUEEK_API_HOSTS`. `QUEEK_DEV_API_HOSTS` is for local tunnels and is refused when `NODE_ENV=production`.

### Timeouts, aborts and retries

- Every attempt times out after 30 seconds. Change it with `timeoutMs` on the client or on one call; `0` turns the client timeout off.
- Pass `signal` to cancel a call. A cancelled call fails with `request_aborted` and is never retried.
- `request()` never retries. `requestWithRetry()` retries 429, 502, 503, 504, timeouts and network errors, up to 3 attempts, with exponential backoff and jitter. It honours `Retry-After` up to `maxRetryAfterMs` (30 seconds) and throws at once when Queek asks for longer.
- Writes (`POST`, `PUT`, `PATCH`, `DELETE`) carry an `Idempotency-Key`: yours, or a random UUID. All attempts of one write send the same key, so Queek replays the first result instead of running the write twice.
- Pass `requestId` to correlate your trace with Queek's logs. Without it, the client generates one.

Encode path segments yourself (`encodeURIComponent`). Query values are encoded for you.

### Pagination

List endpoints return `{ data, has_more, next_cursor }` and take `limit` and `starting_after`. `paginate` walks every page:

```ts
import { paginate } from "@usequeek/app-sdk";

// client is the installation client created above.
for await (const order of paginate<{ p_id: string }>(client, "/orders", { limit: 50 })) {
  console.log(order.p_id);
}
```

### Errors

Every failed call throws `QueekApiError`. Switch on `code`, never on `message`.

| Property | Meaning |
| --- | --- |
| `status` | HTTP status, or `0` when no answer arrived. |
| `code` | Stable machine code. |
| `message` | What happened and what to do. For people, not for `switch`. |
| `requestId` | Matches the `X-Request-Id` response header. Quote it to Queek support. |
| `field`, `errors` | Validation detail for `validation_failed`. |
| `docUrl` | The entry for this code in the error reference. |
| `retryAfterMs` | On a 429, how long Queek asked you to wait. |
| `cause` | The original error, for failures that never got an answer. |
| `isRetryable` | True for the failures `requestWithRetry()` retries. |

Codes from Queek are listed in the [Merchant API reference](https://api.usequeek.com/docs/merchant.json) (`validation_failed`, `insufficient_scope`, `too_many_requests`, and more). The SDK adds these:

| Code | Meaning |
| --- | --- |
| `network_error` | No connection: DNS, refused or reset connection, TLS. Retryable. |
| `request_timeout` | No answer within `timeoutMs`. Retryable. |
| `request_aborted` | Your `AbortSignal` fired. Not retried. |
| `invalid_response` | An HTTP success whose body was not JSON, or a page that promised more rows and gave no cursor. |
| `invalid_api_base` | Thrown as `InvalidApiBaseError` when the client is created. |

```ts
import { QueekApiError } from "@usequeek/app-sdk";

try {
  await client.request("POST", "/orders/ord_123/status", { body });
} catch (error) {
  if (error instanceof QueekApiError && error.code === "validation_failed") {
    console.error(error.field, error.errors, error.requestId);
  } else {
    throw error;
  }
}
```

### Types

The default types come from the Merchant API spec bundled in this package. They do not update by themselves when the API gains fields. For current types, run `queek app codegen` in your app and pass the result: `createInstallationClient<AppPaths>(…)`. The API only adds fields within `v1`, so an older SDK keeps working with new fields untyped.

## Verify a signature yourself

```ts
import { type InstallationRecord, verifyQueekSignatureDetailed } from "@usequeek/app-sdk";

export async function verifyDelivery(request: Request, installation: InstallationRecord): Promise<Response | null> {
  const checked = verifyQueekSignatureDetailed({
    id: request.headers.get("webhook-id") ?? "",
    timestamp: request.headers.get("webhook-timestamp") ?? "",
    signatureHeader: request.headers.get("webhook-signature") ?? "",
    body: await request.text(), // the raw text, before any JSON.parse
    secret: installation.webhookSecret ?? "",
  });
  return checked.ok ? null : new Response(checked.reason, { status: 401 });
}
```

The MAC key is the base64-decoded bytes of the `whsec_…` secret. The compare is constant-time and checks every signature in the header, so a secret rotation that sends two signatures verifies. The timestamp must be a plain integer within 5 minutes of now. A valid signature on a stale delivery is still rejected, which bounds replay. The `webhook-id` claim in the handlers closes the rest of the window.

## Embedded merchant page

The dashboard frames your merchant page and passes a session token. Verify it on your server before you trust the call:

```ts
import { verifySessionTokenDetailed } from "@usequeek/app-sdk/server";

const checked = await verifySessionTokenDetailed(token, {
  secret: installation.embedSecret ?? "",
  audience: "my-app", // your app slug
  issuer: installation.apiBase,
  expected: {
    installationId: installation.installationId,
    vendorId: installation.vendorId,
    appSlug: "my-app",
    appId: installation.appId ?? "",
  },
});
if (!checked.ok) throw new Error(`session token rejected: ${checked.reason}`);
```

Tokens are HS256 with a 20-second clock tolerance. The verifier pins the algorithm, then checks signature, audience, issuer, expiry and the installation binding. `sessionTokenInstallationId(token)` reads the installation id without verifying anything, only so you can load the right secret. Never trust it on its own.

In the browser, `installAuthFetch({ exchange, dashboardOrigin })` from `@usequeek/app-sdk/browser` reads the first-load token from `?queek_token=`, removes it from the URL, exchanges it once through your `exchange` endpoint, attaches `Authorization: Bearer <session>` to same-origin requests, and refreshes through the bridge after a 401. Cookies are not used. In React, wrap the app in `<QueekProvider>` and call `useQueek()` for `toast`, `saveBar`, `title`, `navigate`, `pickResource` and `theme`.

Serve the page with a `frame-ancestors` policy that names only your dashboard origin:

```http
Content-Security-Policy: frame-ancestors https://dashboard.usequeek.com
```

Replace the host with the dashboard origin you registered. Only your server can set this header, so the dashboard cannot enforce it for you.

## Credentials and tokens

An app holds one asymmetric key. Queek hands no store-callable credential over in the install handoff; the app mints short-lived installation tokens on demand.

1. **Create a key pair.** Either generate it yourself and upload the public key on the Developer page, so Queek never sees the private key:

   ```sh
   openssl genrsa -out app-private.pem 2048
   openssl rsa -in app-private.pem -pubout -out app-public.pem
   ```

   Or run `queek app dev`, which generates a pair and stores the key id and private key (base64, one line) in `.queek/.env.local`. The server shows the private key once. If you lose it, generate a new key.

2. **Set five values.**
   - `APP_SLUG`: the slug in `queek.app.toml`. It is the JWT `iss`.
   - `APP_KEY_ID`: the key id from the Developer page.
   - `APP_PRIVATE_KEY`: the matching private key. Base64 of the PEM, raw PEM, and `\n`-escaped one-line PEM are accepted. It is never logged.
   - `QUEEK_APP_SECRET`: verifies the install handoff. It is shown once at registration.
   - `APP_ENCRYPTION_KEY`: 32 random bytes as base64 or hex. Prefer random bytes over a typed passphrase.

3. **Acquire, cache, re-mint.** `acquireToken(installationId)` returns the cached token while more than 5 minutes remain. Otherwise it signs an RS256 app JWT (`iss` = slug, `iat` = now minus 60 s, `exp` = `iat` + 540 s, header `kid`), posts it to mint a token, and stores the token encrypted. Concurrent callers in one process share one mint.

4. **Failures are handled by status and code.**
   - `401 invalid_client`: fatal for the app. Minting stops and the SDK logs loudly. Fix `APP_PRIVATE_KEY` or `APP_KEY_ID`, then restart or call `resumeMinting()`.
   - `403 app_token_revoked`: Queek disabled the app. The SDK drops every cached token and stops minting until the app is re-enabled and the process restarts.
   - `404 app_installation_gone`: the installation was removed. The SDK purges that row.
   - `409 app_installation_pending`: the installation is not active yet. The SDK retries later with backoff and never purges it.
   - `429`: `Retry-After` is honoured with jitter. A `resync_cooldown` (one resync per installation per hour) is skipped, not retried.
   - `5xx`, timeouts and network errors: bounded exponential backoff.

5. **Rotate a key.** Add a new key id (both verify), switch the app to it, wait one token lifetime, then remove the old key id.

## Resync and backups

The app database holds installations only: references, the token cache, webhook secrets and settings. Business data lives in Queek.

After a database loss or a long outage, `resyncFromQueek({ apiBase, tokens, store })` lists the app's active installations and asks Queek to redeliver each one's secrets and settings over the signed install channel. It purges local rows Queek no longer lists, except rows marked pending. Resync restores connectivity. It does not restore your own working data or webhook events that Queek stopped retrying. Back up the app database (`pg_dump`) and `APP_ENCRYPTION_KEY`. Without the key, stored secrets cannot be recovered.

## Data deletion

Treat the `app/uninstalled` handoff as your deletion trigger. The default `onUninstall` deletes the installation row, including secrets, token cache and settings. Keep that delete if you override it, and remove any app data keyed by the installation.

A topic with no handler answers 200 and reports `unhandled: true`. It deletes nothing. If Queek adds mandatory privacy topics, register explicit handlers for them.

## Storefront proxy

Queek signs each storefront proxy read with the installation's `proxy_secret`. Verify before you answer:

```ts
import { handleProxyRequest, type InstallationStore } from "@usequeek/app-sdk";

declare const store: InstallationStore;
declare function slotsFor(date: string | undefined, storePid: string | null): unknown;

export async function GET(request: Request) {
  return handleProxyRequest(
    request,
    { store, path: "/apps/booking/availability" }, // the path Queek signed, not your local route
    ({ installation, params }) => Response.json({ slots: slotsFor(params.date, installation.storePid) }),
  );
}
```

The canonical string is `path`, `shop`, `ts` and the sorted, percent-encoded query pairs (without `sig`), joined with newlines. The signature is a hex HMAC-SHA256 keyed with the full `whsec_…` string, with no base64 decode. `kid` selects the installation, timestamps may skew by 5 minutes, each `jti` is single-use, and only `GET` is served. With Hono, mount `createProxyHandler({ store, path, onVerified })`.

## Scopes

Apps declare required scopes (granted at install) and optional scopes (requested later, revocable).

```ts
import { createInstallationScopesClient } from "@usequeek/app-sdk";

const scopes = createInstallationScopesClient({
  installationId,
  store,
  signJwt: () => tokens.signJwt(),
  appSlug: "my-app",
  optionalScopes: ["merchant-orders-read"],
});

await scopes.queryScopes(); // { granted, optional }, from the cache, no network
scopes.requestScopes(["merchant-orders-read"]); // dashboard consent link; open it with sendOpen
await scopes.revokeScopes(["merchant-orders-read"]); // 422 app_scope_required becomes AppScopeRequiredError
```

The grant arrives as a signed `app/scopes_update` handoff. The install and settings handlers apply it, and drop the cached token only when the grant changed.

## Local development

- `QUEEK_DEV_API_HOSTS` (comma-separated hostnames) points the client at a local tunnel. It is refused when `NODE_ENV=production`.
- Without `DATABASE_URL`, `createInstallationStore()` uses SQLite. In production it refuses SQLite and requires `DATABASE_URL`.
- Set `LOG_LEVEL` to `debug`, `info`, `warn` or `error` to change the logger threshold.

## API surface

Every export has JSDoc in its type definitions. By module:

| Module | What it gives you |
| --- | --- |
| `app-auth` | `loadAppCredential`, `signAppJwt`, the error code constants, `AppMintHaltedError` |
| `tokens` | `createAppTokenProvider`, `createInstallationClient` |
| `client` | `createQueekClient`, `paginate`, `QueekApiError`, `resolveApiBase` |
| `install-handlers` | `handleInstallDelivery`, `handleInstallRequest`, `saveResyncedInstallation` |
| `webhooks` | `handleWebhookDelivery`, `handleWebhookRequest` |
| `signatures` | `verifyQueekSignature`, `verifyQueekSignatureDetailed`, `signQueekPayload` |
| `proxy` | `verifyProxyQuery`, `verifyProxyDelivery`, `handleProxyRequest` |
| `store` | `SqliteInstallationStore`, `PostgresInstallationStore`, `createInstallationStore` |
| `resync`, `background` | `resyncFromQueek`, `runInstallationCatchup`, `detach` |
| `scopes` | `createInstallationScopesClient`, `AppScopeRequiredError` |
| `session` (`/server`) | `verifySessionToken`, `verifySessionTokenDetailed` |
| `frame`, `theme`, `auth-fetch` (`/browser`) | The embedded-page bridge, `installAuthFetch`, theme helpers |
| `react` (`/react`) | `QueekProvider`, `useQueek` |
| `logger` | `createLogger`, with secret redaction for keys, `whsec_` secrets, bearer tokens, JWTs and PEM blocks |

Installations are encrypted at rest with AES-256-GCM using `APP_ENCRYPTION_KEY`. The Postgres store takes an advisory lock while it creates its schema, so two containers can start together.

## Versioning

The package follows semantic versioning once it reaches 1.0. Before that, a minor version can contain breaking changes, and each one is listed in [CHANGELOG.md](./CHANGELOG.md). The Merchant API is versioned separately: `v1` only adds fields and values, and a breaking change ships as `v2` beside it.

## Contributing

```sh
npm ci
npm run build && npm run typecheck && npm run typecheck:tests
npm run lint
npm test
```

`npm test` also runs a public-text guard that fails on internal references and secret-shaped strings. Postgres tests run when `DATABASE_URL` points at a database and skip otherwise. `src/merchant-schema.ts` is generated from `openapi/merchant.json` by `npm run gen:merchant`: change the spec, never the generated file. Open an issue before a large change.

## Security

Report a vulnerability privately through this repository's security advisories, not in a public issue. Include the SDK version and a minimal reproduction. Never include a real secret.

## License

MIT. Copyright Queekx Technology LTD. See [LICENSE](./LICENSE).
