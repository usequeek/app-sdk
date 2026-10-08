import { type CoreDelivery, type DeliveryResult, decodeBody, readHeader, toResponse } from "./delivery.js";
import {
  MAX_TIMESTAMP_SKEW_SECONDS,
  verifyQueekSignature,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "./signatures.js";
import type { InstallationRecord, InstallationStore } from "./store.js";

/**
 * Framework-agnostic receiver for Queek topic deliveries (one signed POST
 * per installation endpoint) in three thin layers: layer 1
 * `handleWebhookDelivery(input, options)` takes plain data (untouched body
 * bytes + headers) and returns a plain `{ status, body }` result — zero
 * request/response types, so whatever request object each framework
 * supports works; layer 2 `handleWebhookRequest(request, options)` adapts
 * the Web standard onto layer 1; layer 3 (`@usequeek/app-sdk/hono`)
 * adapts Hono onto layer 2.
 *
 * Delivery envelope: `{ id, topic, api_version: "v1", created_at, data }`
 * with `X-Queek-Topic` echoing `topic`. Verification uses the
 * PER-INSTALLATION endpoint secret handed over once inside the install
 * payload (`data.webhook_secret`) — never the app signing secret.
 *
 * Secret lookup: topic payloads are resource renders with no guaranteed
 * installation/vendor id, so the default resolver identifies the
 * installation by trying each stored installation secret against the
 * signature (the signature itself names the sender; HMACs are microseconds,
 * installations per app are few). Apps that carry their own routing hint
 * may pass `resolveSecret` instead.
 *
 * Dedupe: Queek retries a delivery for ~4h until it sees 2xx, so every
 * `webhook-id` is processed AT MOST once — the header id is claimed
 * atomically up front (exactly one concurrent same-id delivery runs the
 * handler) and a repeat answers 200 WITHOUT re-running it. A throwing
 * handler releases the claim and answers 500 so the retry can land.
 * Unknown topics answer 200 too (a topic the app no longer handles must
 * not wedge Queek's retry queue); only auth and malformed bodies are
 * non-2xx.
 */

export const QUEEK_TOPIC_HEADER = "X-Queek-Topic";

export interface QueekWebhookEnvelope<TData = unknown> {
  id: string;
  topic: string;
  api_version: "v1";
  created_at: string;
  data: TData;
}

export interface WebhookHandlerContext {
  installation: InstallationRecord;
  topic: string;
  eventId: string;
}

export type WebhookHandlerFn<TData = unknown> = (
  envelope: QueekWebhookEnvelope<TData>,
  context: WebhookHandlerContext,
) => Promise<void>;

export interface SecretResolution {
  installationId: string;
  secret: string;
}

export interface WebhookHandlerOptions {
  store: InstallationStore;
  /** `topic → handler`, e.g. `{ "orders/updated": onOrderUpdated }`. */
  handlers: Record<string, WebhookHandlerFn>;
  /** Override the default try-each-secret resolution. */
  resolveSecret?: (
    envelope: QueekWebhookEnvelope | null,
    rawBody: string,
    headers: { id: string; timestamp: string; signatureHeader: string },
  ) => Promise<SecretResolution | null>;
  nowSeconds?: number;
  maxSkewSeconds?: number;
}

async function defaultResolveSecret(
  store: InstallationStore,
  rawBody: string,
  headers: { id: string; timestamp: string; signatureHeader: string },
  envelope: QueekWebhookEnvelope | null,
): Promise<SecretResolution | null> {
  // Fast path: handoff-shaped payloads that name their installation.
  const data = envelope?.data as Record<string, unknown> | null | undefined;
  const named =
    data !== null && typeof data === "object"
      ? ((data.installation as Record<string, unknown> | undefined)?.id as string | undefined)
      : undefined;
  if (typeof named === "string" && named !== "") {
    const found = await store.getInstallation(named);
    const secret = found?.webhookSecret;
    if (
      found &&
      secret &&
      verifyQueekSignature({ ...headers, body: rawBody, secret }, { skipFreshnessCheck: true })
    ) {
      return { installationId: found.installationId, secret };
    }
    return null;
  }
  // General path: the signature identifies the sender.
  const candidates = await store.listWebhookSecrets();
  for (const candidate of candidates) {
    if (
      verifyQueekSignature(
        { ...headers, body: rawBody, secret: candidate.secret },
        { skipFreshnessCheck: true },
      )
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Layer 1: handle one signed Queek topic delivery from plain data — no
 * `Request`, no framework. Same options, same behaviour, same
 * errors/status codes at every layer.
 */
export async function handleWebhookDelivery(
  input: CoreDelivery,
  options: WebhookHandlerOptions,
): Promise<DeliveryResult> {
  const maxSkew = options.maxSkewSeconds ?? MAX_TIMESTAMP_SKEW_SECONDS;
  const rawBody = decodeBody(input.rawBody);
  const id = readHeader(input.headers, WEBHOOK_ID_HEADER);
  const timestamp = readHeader(input.headers, WEBHOOK_TIMESTAMP_HEADER);
  const signatureHeader = readHeader(input.headers, WEBHOOK_SIGNATURE_HEADER);
  if (!id || !timestamp || !signatureHeader) {
    return { status: 401, body: { ok: false, error: "missing signature headers" } };
  }

  let envelope: QueekWebhookEnvelope | null = null;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (typeof parsed === "object" && parsed !== null) envelope = parsed as QueekWebhookEnvelope;
  } catch {
    return { status: 400, body: { ok: false, error: "invalid_json" } };
  }
  if (!envelope || typeof envelope.topic !== "string") {
    return { status: 400, body: { ok: false, error: "invalid_envelope" } };
  }

  const headers = { id, timestamp, signatureHeader };
  const resolution = options.resolveSecret
    ? await options.resolveSecret(envelope, rawBody, headers)
    : await defaultResolveSecret(options.store, rawBody, headers, envelope);
  if (!resolution) {
    return { status: 401, body: { ok: false, error: "unknown_installation" } };
  }

  // Freshness is enforced HERE, once, against the resolved secret — the
  // lookup above deliberately skips it so a stale delivery cannot be
  // misattributed before it is rejected.
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > maxSkew) {
    return { status: 401, body: { ok: false, error: "stale timestamp" } };
  }
  // Freshness was enforced above; this re-checks the MAC only, so a
  // custom resolver cannot claim an installation without its secret.
  if (
    !verifyQueekSignature(
      { ...headers, body: rawBody, secret: resolution.secret },
      { skipFreshnessCheck: true },
    )
  ) {
    return { status: 401, body: { ok: false, error: "signature mismatch" } };
  }

  const installation = await options.store.getInstallation(resolution.installationId);
  if (!installation) {
    return { status: 401, body: { ok: false, error: "unknown_installation" } };
  }

  // Atomic claim on the HEADER id: exactly one concurrent same-id
  // delivery runs the handler; the rest answer deduped.
  if (!(await options.store.claimWebhookId(id))) {
    return { status: 200, body: { ok: true, deduped: true } };
  }

  const topic = readHeader(input.headers, QUEEK_TOPIC_HEADER) ?? envelope.topic;
  const handler = options.handlers[topic];
  if (!handler) {
    // No handler for this topic is NOT a failure: answering non-2xx would
    // retry for hours something the app will never handle. The claim
    // stands as the seen-record.
    return { status: 200, body: { ok: true, unhandled: true } };
  }

  try {
    await handler(envelope, { installation, topic, eventId: id });
  } catch {
    await options.store.releaseWebhookId(id);
    return { status: 500, body: { ok: false, error: "handler_failed" } };
  }
  return { status: 200, body: { ok: true } };
}

/**
 * Layer 2: the Web-standard wrapper, built ONLY on layer 1 — reads
 * `await request.arrayBuffer()` + headers, calls the core, builds the
 * `Response`. Only `POST` is served; anything else answers 405.
 */
export async function handleWebhookRequest(
  request: Request,
  options: WebhookHandlerOptions,
): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return toResponse({ status: 405, body: { ok: false, error: "method_not_allowed" } });
  }
  return toResponse(
    await handleWebhookDelivery(
      {
        rawBody: new Uint8Array(await request.arrayBuffer()),
        headers: request.headers,
      },
      options,
    ),
  );
}
