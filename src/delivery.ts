/**
 * Shared plumbing for the framework-free delivery core (layer 1).
 *
 * Layer 1 functions take plain data — untouched body bytes plus headers —
 * and return plain `{ status, body }` results. They reference zero
 * request/response types (no `Request`, no framework), so any framework
 * that can hand over the raw body bytes can use them. Layer 2
 * (`handleInstallRequest` / `handleWebhookRequest`) adapts the Web
 * standard onto this core; `@usequeek/app-sdk/hono` adapts Hono onto
 * layer 2.
 *
 * The raw-body rule: `rawBody` must be the exact bytes Queek signed (the
 * Standard Webhooks signature covers `{id}.{timestamp}.{body}`). Never pass
 * a parsed-then-restringified body — JSON re-serialization changes bytes
 * (spacing, key order) and the signature will not verify.
 */

/** Headers as any framework holds them: a `Headers` instance, or a plain object (Express-style: lowercased keys, array values allowed). */
export type CoreHeaders = Record<string, string | string[] | undefined> | Headers;

/** The framework-free delivery input both core handlers take. */
export interface CoreDelivery {
  /** The untouched body bytes Queek signed (string is used verbatim; binary is UTF-8-decoded). */
  rawBody: Uint8Array | Buffer | string;
  headers: CoreHeaders;
}

/** Layer-1 input for the install handoff, which genuinely needs routing. */
export interface InstallDelivery extends CoreDelivery {
  /** Defaults to `"POST"`. Anything else answers 405. */
  method?: string;
  /** Request path (`/install`, …) or full URL — routes on the trailing `install` / `uninstall` / `settings` segment. */
  path?: string;
}

/** What the layer-1 core returns: an HTTP status plus a JSON-serializable body. */
export interface DeliveryResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Case-insensitive header lookup across `Headers` and plain (possibly lowercased, possibly array-valued) objects. */
export function readHeader(headers: CoreHeaders, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want) {
      if (value === undefined) return undefined;
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

/** Decode untouched body bytes to the exact string Queek signed. */
export function decodeBody(rawBody: Uint8Array | Buffer | string): string {
  if (typeof rawBody === "string") return rawBody;
  return new TextDecoder("utf-8").decode(rawBody);
}

/** Build the layer-2 `Response` from a layer-1 result. */
export function toResponse(result: DeliveryResult): Response {
  return Response.json(result.body, { status: result.status, headers: result.headers });
}
