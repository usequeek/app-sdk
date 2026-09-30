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
 * that verifies the launch/bridge token (server-side, via
 * `verifySessionToken`) and mints the app session. This module never sees
 * secrets — it only carries opaque tokens.
 *
 * DOM-free by design (like `frame.ts`): location/history access is
 * injectable and defaults to the global window when present.
 */

import { type EmbedEventTarget, type EmbedPostTarget, listenToDashboard, sendReady } from "./frame.js";

/** Launch token query param on the signed first load. */
export const LAUNCH_TOKEN_PARAM = "id_token";

/** How long to wait for the dashboard's token reply after a `ready`. */
export const BRIDGE_TOKEN_TIMEOUT_MS = 8000;

export interface AuthFetchOptions {
  /** Exchange a dashboard token for the app's own session (caller's endpoint). */
  exchange: (token: string) => Promise<string>;
  /** Exact dashboard origin for the `ready→token` refresh flow. */
  dashboardOrigin: string;
  /** Launch-token query param (default `id_token`). */
  param?: string;
  /** postMessage target for `ready` (defaults to the global window's parent). */
  postTarget?: EmbedPostTarget;
  /** message-event target for the token reply (defaults to the global window). */
  listenTarget?: EmbedEventTarget;
  /** fetch implementation (defaults to the global fetch). */
  fetchImpl?: typeof fetch;
  /** Current href (defaults to the global window location). */
  getHref?: () => string;
  /** Replace the URL without navigating (defaults to history.replaceState). */
  replaceUrl?: (url: string) => void;
}

export interface InstalledAuth {
  /** Session-carrying fetch: same-origin requests gain the Bearer [REDACTED] 401 retries once after refresh. */
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
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

  let pendingToken: { resolve: (token: string) => void; reject: (error: Error) => void } | null = null;

  const stopListening = listenToDashboard({
    dashboardOrigin: options.dashboardOrigin,
    target: listenTarget,
    onToken: (token) => {
      pendingToken?.resolve(token);
      pendingToken = null;
    },
  });

  const waitForBridgeToken = (): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      pendingToken?.reject(new Error("superseded by a newer token request"));
      pendingToken = { resolve, reject };
      sendReady(options.dashboardOrigin, postTarget);
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

  const isSameOrigin = (input: string | URL): boolean => {
    try {
      return new URL(String(input), getHref()).origin === new URL(getHref()).origin;
    } catch {
      return false;
    }
  };

  const withSession = async (
    input: string | URL,
    init: RequestInit | undefined,
    token: string,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (!headers.has("authorization")) {
      headers.set("authorization", `Bearer ${token}`);
    }
    return fetchFn(input as string, { ...init, headers, credentials: "omit" });
  };

  const authFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    if (!isSameOrigin(input)) {
      return fetchFn(input as string, init);
    }
    const current = session ?? (await ready);
    if (current === null) {
      return fetchFn(input as string, { ...init, credentials: "omit" });
    }
    const first = await withSession(input, init, current);
    if (first.status !== 401) {
      return first;
    }
    // One re-establishment per 401, then exactly one retry.
    try {
      const next = await refresh();
      return await withSession(input, init, next);
    } catch {
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
