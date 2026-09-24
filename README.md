# @usequeek/app-sdk

The SDK for building a Queek app on the public Merchant API and signed webhooks. Hono route helpers for the install handoff and topic webhooks, a typed Merchant API client (types generated from the live contract), and an encrypted SQLite installation store.

```sh
npm i @usequeek/app-sdk hono
```

Requires Node `>=22.14`. `hono` is a peer dependency so your app never carries two copies.

## Example

A minimal app: health check, install/uninstall/settings handlers, and one webhook topic (~20 lines):

```ts
import {
  createInstallHandlers,
  createWebhookHandler,
  SqliteInstallationStore,
} from "@usequeek/app-sdk";
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

## API surface

- **verify** (`signatures.ts`): `verifyQueekSignature` — Standard Webhooks verification (`webhook-id`, `webhook-timestamp`, `webhook-signature` over `{id}.{timestamp}.{body}`, keyed by the decoded `whsec_…` bytes), with timestamp-skew enforcement.
- **install handlers** (`install-handlers.ts`): `createInstallHandlers({ appSecret, store, onInstall?, onUninstall?, onSettings? })` — serves the signed install/uninstall/settings handoff. Defaults persist the installation (encrypted) in the store.
- **client** (`client.ts`): `createQueekClient({ apiBase, apiKey })` — typed fetch client over the Merchant API (`X-Client-Key`), with `Idempotency-Key` on writes, typed `QueekApiError`s, and 429 retry helpers. Types come from `openapi/merchant.json`, the committed snapshot of the live contract.
- **webhooks** (`webhooks.ts`): `createWebhookHandler({ store, handlers })` — verifies each delivery against the installation's endpoint secret, dedupes on `webhook-id`, and dispatches `topic → handler` at most once.
- **store** (`store.ts`): `SqliteInstallationStore` — installations encrypted at rest (AES-GCM via `APP_ENCRYPTION_KEY`), plus the seen-webhook-id claim table behind dedupe. Set once when the app is deployed; installs never change env: each install adds a row to the app's database, with that store's API key encrypted using this key.

## Local development

Point the client at a local backend with `QUEEK_DEV_API_HOSTS` (comma-separated hosts). It is refused when `NODE_ENV=production`, so it can never weaken a live app. See `devApiHostsFromEnv` in `client.ts`.

## Registration

App registration is by the Queek team today: you ship Queek your manifest URL and receive the app secret + store key. There is no public self-serve registration yet.

## License

MIT — see [LICENSE](./LICENSE).

