/**
 * Same-origin session carriage for embedded apps (U-validation "Auth
 * carriage"): `installAuthFetch()` reads the launch token from the signed
 * first load, exchanges it ONCE for the app's own session, and attaches
 * `Authorization: Bearer <session>` to every same-origin fetch. A 401
 * re-establishes the session via the bridge `ready→token` flow and retries
 * once. Cookies stay out (`credentials: "omit"` on handled requests —
 * the cross-site iframe cannot rely on them anyway).
 *
 * The caller supplies `exchange(token) => session`: the app's own endpoint
 * that verifies the dashboard token server-side and mints the app
 * session — the exchange runs once on the signed first load so the first
 * paint needs no bridge round-trip, and again (same callback) with a
 * bridge token after every 401 refresh. The endpoint therefore receives
 * the LAUNCH token on first load and a BRIDGE token on every refresh, so
 * it must try `verifyLaunchTokenDetailed`/`verifyLaunchToken` first and
 * fall back to `verifySessionToken` (both purposes). This module never
 * sees secrets — it only carries opaque tokens.
 *
 * DOM-free by design (like `frame.ts`): location/history access is
 * injectable and defaults to the global window when present.
 */

import { type EmbedEventTarget, type EmbedPostTarget, listenToDashboard, sendReady } from "./frame.js";

/**
 * Launch token query param on the signed first load. Matches the dashboard
 * frame src contract (`launchFrameUrl` in queek-merchant: the ONLY token
 * that may ride a URL, namespaced so it cannot collide with an app's own
 * `token` param).
 */
export const LAUNCH_TOKEN_PARAM = "queek_token";

/** How long to wait for the dashboard's token reply after a `ready`. */
export const BRIDGE_TOKEN_TIMEOUT_MS = 8000;

export interface AuthFetchOptions {
  /**
   * Exchange a dashboard token for the app's own session (caller's endpoint).
   * The endpoint receives the LAUNCH token on first load and a BRIDGE token
   * on every 401 refresh through this same callback, so it must try
   * `verifyLaunchTokenDetailed`/`verifyLaunchToken` first and fall back to
   * `verifySessionToken` (both purposes).
   */
  exchange: (token: string) => Promise<string>;
  /** Exact dashboard origin for the `ready→token` refresh flow. */
  dashboardOrigin: string;
  /** Launch-token query param (default `queek_token`). */
  param?: string;
  /** postMessage target for `ready` (defaults to the global window's parent). */
  postTarget?: EmbedPostTarget;
  /**
   * Capabilities announced in the refresh `ready` — pass the SAME list as the
   * React provider / theme listener so the dashboard sees one consistent set.
   */
  capabilities?: string[];
  /** SDK version announced in the refresh `ready`. */
  sdkVersion?: string;
  /** message-event target for the token reply (defaults to the global window). */
  listenTarget?: EmbedEventTarget;
  /**
   * Required `event.source` for bridge messages. Defaults to the global
   * window's parent when present (the embedding dashboard); pass `null` to
   * disable the source check.
   */
  expectSource?: unknown;
  /** fetch implementation (defaults to the global fetch). */
  fetchImpl?: typeof fetch;
  /** Current href (defaults to the global window location). */
  getHref?: () => string;
  /** Replace the URL without navigating (defaults to history.replaceState). */
  replaceUrl?: (url: string) => void;
}

export interface InstalledAuth {
  /** Session-carrying fetch: same-origin requests gain the session as a Bearer token, and a 401 retries once after a refresh. */
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Current app session, or null before the exchange settles / without a token. */
  getSession: () => string | null;
  /** Settles to the session, or null when there is no launch token to exchange. */
  ready: Promise<string | null>;
  /** Re-establish the session via the bridge `ready→token` flow. */
  refresh: () => Promise<string>;
  /** Unsubscribe the bridge token listener. */
  dispose: () => void;
}

interface WindowLike {
  location: { href: string };
  history: { replaceState(data: unknown, unused: string, url: string): void };
  parent?: EmbedPostTarget;
  addEventListener(type: "message", listener: (event: { origin: string; data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { origin: string; data: unknown }) => void): void;
}

function globalWindow(): WindowLike | null {
  const scope = globalThis as unknown as { window?: WindowLike };
  return scope.window?.location !== undefined ? (scope.window ?? null) : null;
}

/** Read the launch token from a URL without touching it. */
export function readLaunchToken(href: string, param: string = LAUNCH_TOKEN_PARAM): string | null {
  try {
    const token = new URL(href, "https://app.invalid").searchParams.get(param);
    return token !== null && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Strip the launch token from a URL (every other param, plus the hash, is
 * preserved). Returns the stripped href, or null when no token is present.
 */
export function stripLaunchToken(href: string, param: string = LAUNCH_TOKEN_PARAM): string | null {
  try {
    const url = new URL(href, "https://app.invalid");
    if (!url.searchParams.has(param)) {
      return null;
    }
    url.searchParams.delete(param);
    return url.toString();
  } catch {
    return null;
  }
}

export function installAuthFetch(options: AuthFetchOptions): InstalledAuth {
  const param = options.param ?? LAUNCH_TOKEN_PARAM;
  const win = globalWindow();
  const getHref = options.getHref ?? (() => win?.location.href ?? "");
  const replaceUrl = options.replaceUrl ?? ((url: string) => win?.history.replaceState(null, "", url));
  const fetchImpl = options.fetchImpl ?? (globalThis as unknown as { fetch?: typeof fetch }).fetch ?? null;
  if (fetchImpl === null) {
    throw new Error("installAuthFetch needs a fetch implementation");
  }
  const fetchFn: typeof fetch = fetchImpl;
  const listenTarget = options.listenTarget ?? (win as unknown as EmbedEventTarget | null) ?? undefined;
  const postTarget = options.postTarget ?? win?.parent;

  // Signed first load: read the launch token, strip it from the URL bar
  // immediately (it must not linger in history), exchange it once.
  const href = getHref();
  const launchToken = readLaunchToken(href, param);
  const stripped = launchToken === null ? null : stripLaunchToken(href, param);
  if (stripped !== null) {
    try {
      replaceUrl(stripped);
    } catch {
      // A denied replaceState must not break the exchange.
    }
  }

  let session: string | null = null;
  let exchangePromise: Promise<string> | null = null;
  let refreshPromise: Promise<string> | null = null;

  const runExchange = (token: string): Promise<string> => {
    if (exchangePromise === null) {
      exchangePromise = options.exchange(token).then((next) => {
        session = next;
        return next;
      });
      // A failed first exchange must not poison later refreshes.
      exchangePromise.catch(() => {
        if (session === null) {
          exchangePromise = null;
        }
      });
    }
    return exchangePromise;
  };

  const ready: Promise<string | null> =
    launchToken === null ? Promise.resolve(null) : runExchange(launchToken).catch(() => null);

  // A recovery only makes sense inside a dashboard frame: unframed, nothing
  // can ever answer the ready. After one failed recovery, later requests skip
  // it (no 8s stall per fetch) until a later token proves the dashboard is
  // talking.
  const framed = postTarget !== undefined && postTarget !== (win as unknown as EmbedPostTarget | null);
  let recoveryFailed = false;

  let pendingToken: { resolve: (token: string) => void; reject: (error: Error) => void } | null = null;

  const expectSource = options.expectSource !== undefined ? options.expectSource : (win?.parent ?? undefined);

  const stopListening = listenToDashboard({
    dashboardOrigin: options.dashboardOrigin,
    target: listenTarget,
    expectSource: expectSource ?? undefined,
    onToken: (token) => {
      recoveryFailed = false;
      pendingToken?.resolve(token);
      pendingToken = null;
    },
  });

  const waitForBridgeToken = (): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      pendingToken?.reject(new Error("superseded by a newer token request"));
      pendingToken = { resolve, reject };
      sendReady(options.dashboardOrigin, postTarget, {
        capabilities: options.capabilities,
        sdkVersion: options.sdkVersion,
      });
      const timer = setTimeout(() => {
        if (pendingToken?.resolve === resolve) {
          pendingToken = null;
          reject(new Error("timed out waiting for the dashboard token"));
        }
      }, BRIDGE_TOKEN_TIMEOUT_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
    });

  const refresh = (): Promise<string> => {
    if (refreshPromise === null) {
      refreshPromise = waitForBridgeToken()
        .then((token) => {
          exchangePromise = null;
          return runExchange(token);
        })
        .finally(() => {
          refreshPromise = null;
        });
    }
    return refreshPromise;
  };

  /**
   * Resolve the request URL without coercing: a `Request` carries its URL in
   * `.url` (`String(request)` is `"[object Request]"` and would resolve
   * same-origin — leaking the bearer cross-origin). Anything that is not a
   * string, URL, or Request resolves to null and never gains a bearer.
   */
  const requestUrl = (input: string | URL | Request): string | null => {
    try {
      if (typeof Request !== "undefined" && input instanceof Request) {
        return input.url;
      }
      if (input instanceof URL) {
        return input.href;
      }
      if (typeof input === "string") {
        return input;
      }
      return null;
    } catch {
      return null;
    }
  };

  const isSameOrigin = (url: string): boolean => {
    try {
      return new URL(url, getHref()).origin === new URL(getHref()).origin;
    } catch {
      return false;
    }
  };

  const withSession = async (
    input: string | URL | Request,
    init: RequestInit | undefined,
    token: string,
  ): Promise<Response> => {
    // A fresh clone per attempt: a body-carrying Request is consumed by its
    // first fetch, so the 401 retry would otherwise throw.
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    const attempt = isRequest ? (input as Request).clone() : input;
    // Merge: the Request's own headers first, the explicit init wins.
    const headers = new Headers(isRequest ? (input as Request).headers : undefined);
    if (init?.headers !== undefined) {
      new Headers(init.headers).forEach((value, key) => {
        headers.set(key, value);
      });
    }
    if (!headers.has("authorization")) {
      headers.set("authorization", `Bearer ${token}`);
    }
    return fetchFn(attempt as string, { ...init, headers, credentials: "omit" });
  };

  const recover = async (): Promise<string | null> => {
    if (!framed || recoveryFailed) {
      return null;
    }
    try {
      return await refresh();
    } catch {
      recoveryFailed = true;
      return null;
    }
  };

  const authFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (url === null || !isSameOrigin(url)) {
      return fetchFn(input as string, init);
    }
    // No session yet (e.g. no launch token after an in-frame hard reload):
    // recover via the bridge ready→token flow before giving up — framed only,
    // and not again after a failed attempt.
    const used = session ?? (await ready) ?? (await recover());
    if (used === null) {
      return fetchFn(input as string, { ...init, credentials: "omit" });
    }
    const first = await withSession(input, init, used);
    if (first.status !== 401) {
      return first;
    }
    // Someone else already refreshed while we were in flight: retry once
    // with the current session instead of refreshing again.
    if (session !== null && session !== used) {
      return withSession(input, init, session);
    }
    // One re-establishment per 401, then exactly one retry — through the
    // same framed / remembered-failure gate as the no-session path.
    const next = await recover();
    if (next === null) {
      return first;
    }
    try {
      return await withSession(input, init, next);
    } catch {
      recoveryFailed = true;
      return first;
    }
  };

  return {
    fetch: authFetch,
    getSession: () => session,
    ready,
    refresh,
    dispose: () => {
      pendingToken?.reject(new Error("disposed"));
      pendingToken = null;
      stopListening();
    },
  };
}
