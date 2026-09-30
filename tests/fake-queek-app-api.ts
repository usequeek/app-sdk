import { createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { vi } from "vitest";

/**
 * In-process fake Queek app-credential + merchant API for S1 tests. NEVER
 * touched by production code; the backend (B1/B2) is built in parallel
 * against the same wire contract and is not deployed.
 *
 * Routes (all under one fake origin, e.g. https://api.usequeek.com):
 * - `POST /api/v1/apps/installations/{id}/access_tokens` → 201
 *   `{token, expires_at, expires_in}`. The `Authorization: Bearer` JWT is
 *   VERIFIED (RS256 against the test keypair, `kid` + `iss` + the
 *   `exp − iat ≤ 600 s` window) — anything else gets 401 `invalid_client`,
 *   exactly like the contract. Override per call with `mintQueue`.
 * - `GET /api/v1/apps/installations?cursor=` → 200
 *   `{data: [{id, store, api_base, scopes, status}], next_cursor}`,
 *   paginated by `listPageSize` with OPAQUE keyset cursors (unguessable
 *   handles, never offsets — the SDK must echo them verbatim until null).
 *   Lists active installations only (rev 8); pending/throttle/cooldown
 *   refusals are scripted per call with `mintQueue`/`resyncQueue`.
 * - `POST /api/v1/apps/installations/{id}/resync` → 202
 *   `{status: "delivering"}`. Override per call with `resyncQueue`.
 * - `/api/v1/merchant/*` → 200 for `X-Client-Key` values this fake minted
 *   (and not refused), else 401. Override per call with `merchantQueue`.
 */

export interface TestAppKeypair {
  slug: string;
  kid: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

export function testAppKeypair(slug = "test-app", kid = "test-kid-1"): TestAppKeypair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { slug, kid, privateKeyPem: privateKey, publicKeyPem: publicKey };
}

export interface FakeListItem {
  id: string;
  pid?: string;
  storeId?: string;
  storeName?: string;
  apiBase?: string;
  scopes?: string[];
  status?: string;
}

export interface ScriptedFailure {
  status: number;
  code: string;
  message?: string;
  headers?: Record<string, string>;
}

export interface MintRecord {
  installationId: string;
  token: string;
  kid: string | null;
  jwt: string;
}

export interface FakeAppApiOptions {
  keypair: TestAppKeypair;
  /** Installation-token TTL in seconds (default 3600, the founder's decision). */
  tokenTtlSeconds?: number;
  /** Rows served by the list endpoint (default []). */
  listItems?: FakeListItem[];
  /** List page size (default: everything in one page). */
  listPageSize?: number;
  /** FIFO overrides for mint calls (consumed per POST access_tokens). */
  mintQueue?: ScriptedFailure[];
  /** FIFO overrides for resync calls (consumed per POST resync). */
  resyncQueue?: ScriptedFailure[];
  /** FIFO overrides for merchant calls (consumed per /merchant request). */
  merchantQueue?: ScriptedFailure[];
  /** Minted tokens that the merchant API refuses with 401. */
  refuseMerchantTokens?: Set<string>;
  /** Origin the fake serves (default https://api.usequeek.com). */
  origin?: string;
}

export interface RecordedAppCall {
  method: string;
  path: string;
  authorization: string | null;
  clientKey: string | null;
  idempotencyKey: string | null;
  body: string | null;
}

export interface FakeAppApi {
  fetchImpl: typeof fetch;
  mock: ReturnType<typeof vi.fn>;
  mintCalls: MintRecord[];
  listCalls: number;
  resyncCalls: string[];
  merchantCalls: RecordedAppCall[];
  /** Every token this fake minted, by value. */
  issued: Map<string, string>;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function errorBody(code: string, message: string): unknown {
  return { error: { code, message } };
}

function base64UrlJson(segment: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function fakeQueekAppApi(options: FakeAppApiOptions): FakeAppApi {
  const ttl = options.tokenTtlSeconds ?? 3600;
  const origin = options.origin ?? "https://api.usequeek.com";
  const mintCalls: MintRecord[] = [];
  const merchantCalls: RecordedAppCall[] = [];
  const resyncCalls: string[] = [];
  const issued = new Map<string, string>();
  const cursorPositions = new Map<string, number>();
  let listCalls = 0;
  let minted = 0;

  function verifyAppJwt(auth: string | null): { ok: true; kid: string | null } | { ok: false } {
    if (!auth?.startsWith("Bearer ")) return { ok: false };
    const jwt = auth.slice("Bearer ".length).trim();
    const [headerSeg, payloadSeg, sigSeg] = jwt.split(".");
    if (!headerSeg || !payloadSeg || !sigSeg) return { ok: false };
    const header = base64UrlJson(headerSeg);
    const payload = base64UrlJson(payloadSeg);
    if (!header || !payload || header.alg !== "RS256") return { ok: false };
    try {
      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${headerSeg}.${payloadSeg}`, "utf8");
      if (!verifier.verify(options.keypair.publicKeyPem, sigSeg, "base64url")) return { ok: false };
    } catch {
      return { ok: false };
    }
    const now = Math.floor(Date.now() / 1000);
    const iat = payload.iat;
    const exp = payload.exp;
    if (typeof iat !== "number" || typeof exp !== "number") return { ok: false };
    if (exp - iat > 600) return { ok: false };
    if (iat > now + 120 || exp <= now) return { ok: false };
    if (payload.iss !== options.keypair.slug) return { ok: false };
    return { ok: true, kid: typeof header.kid === "string" ? header.kid : null };
  }

  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const request = url instanceof Request ? url : new Request(url.toString(), init);
    const parsed = new URL(request.url);
    const method = (init?.method ?? request.method).toUpperCase();
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    const clientKey = headers.get("x-client-key");
    const path = parsed.pathname;

    const mintMatch = /^\/api\/v1\/apps\/installations\/([^/]+)\/access_tokens$/.exec(path);
    if (method === "POST" && mintMatch) {
      const installationId = decodeURIComponent(mintMatch[1] as string);
      const scripted = options.mintQueue?.shift();
      if (scripted)
        return jsonResponse(
          scripted.status,
          errorBody(scripted.code, scripted.message ?? scripted.code),
          scripted.headers,
        );
      const checked = verifyAppJwt(auth);
      if (!checked.ok) return jsonResponse(401, errorBody("invalid_client", "Bad app JWT."), {});
      minted += 1;
      const token = `tok_${minted}_${randomBytes(8).toString("hex")}`;
      issued.set(token, installationId);
      const jwt = (auth as string).slice("Bearer ".length).trim();
      mintCalls.push({ installationId, token, kid: checked.kid, jwt });
      return jsonResponse(201, {
        token,
        expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
        expires_in: ttl,
      });
    }

    if (method === "GET" && path === "/api/v1/apps/installations") {
      listCalls += 1;
      const checked = verifyAppJwt(auth);
      if (!checked.ok) return jsonResponse(401, errorBody("invalid_client", "Bad app JWT."), {});
      // Opaque keyset cursors (rev 8): the token is an unguessable handle
      // the fake maps back to a position — it never encodes an offset, so
      // a client that parses it as a number walks off the end. Unknown
      // tokens are refused; the SDK must echo them verbatim until null.
      const items = options.listItems ?? [];
      const pageSize = options.listPageSize ?? items.length;
      const cursor = parsed.searchParams.get("cursor");
      let offset = 0;
      if (cursor !== null) {
        const position = cursorPositions.get(cursor);
        if (position === undefined)
          return jsonResponse(400, errorBody("invalid_cursor", "Unknown cursor."), {});
        offset = position;
      }
      const page = items.slice(offset, offset + Math.max(1, pageSize));
      const end = offset + page.length;
      let next: string | null = null;
      if (end < items.length) {
        next = `keyset_${randomBytes(12).toString("hex")}`;
        cursorPositions.set(next, end);
      }
      return jsonResponse(200, {
        data: page.map((item) => ({
          id: item.id,
          store: { id: item.storeId ?? "store-id", name: item.storeName ?? "Test Store" },
          api_base: item.apiBase ?? origin,
          scopes: item.scopes ?? [],
          status: item.status ?? "active",
        })),
        next_cursor: next,
      });
    }

    const resyncMatch = /^\/api\/v1\/apps\/installations\/([^/]+)\/resync$/.exec(path);
    if (method === "POST" && resyncMatch) {
      const installationId = decodeURIComponent(resyncMatch[1] as string);
      const scripted = options.resyncQueue?.shift();
      if (scripted)
        return jsonResponse(
          scripted.status,
          errorBody(scripted.code, scripted.message ?? scripted.code),
          scripted.headers,
        );
      const checked = verifyAppJwt(auth);
      if (!checked.ok) return jsonResponse(401, errorBody("invalid_client", "Bad app JWT."), {});
      resyncCalls.push(installationId);
      return jsonResponse(202, { status: "delivering" });
    }

    if (path.startsWith("/api/v1/merchant")) {
      const rawBody = init?.body;
      merchantCalls.push({
        method,
        path,
        authorization: auth,
        clientKey,
        idempotencyKey: headers.get("idempotency-key"),
        body: typeof rawBody === "string" ? rawBody : null,
      });
      const scripted = options.merchantQueue?.shift();
      if (scripted)
        return jsonResponse(
          scripted.status,
          errorBody(scripted.code, scripted.message ?? scripted.code),
          scripted.headers,
        );
      if (clientKey && issued.has(clientKey) && !options.refuseMerchantTokens?.has(clientKey)) {
        if (path === "/api/v1/merchant/store") {
          return jsonResponse(200, { data: { p_id: "store_xyz", name: "Test Store" } });
        }
        return jsonResponse(200, { data: {} });
      }
      return jsonResponse(401, errorBody("invalid_client_key", "Bad installation token."), {});
    }

    return jsonResponse(404, errorBody("not_found", "Unknown fake route."), {});
  });

  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    mock: fetchImpl,
    mintCalls,
    get listCalls() {
      return listCalls;
    },
    resyncCalls,
    merchantCalls,
    issued,
  };
}
