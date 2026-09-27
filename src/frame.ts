/**
 * Framed-page handshake client (S4 stage 2): the browser-safe half of the
 * dashboard bridge. Carries NO secret and performs NO verification — it only
 * shapes and addresses messages. The dashboard (queek-merchant) enforces
 * origin+source binding and mints tokens; the app backend verifies them via
 * `./server` (`verifySessionToken`).
 *
 * DOM-free by design (structural minimal types): the app passes its own
 * window/parent in, so this module needs no DOM lib and stays import-safe
 * in edge runtimes.
 */

export const DASHBOARD_SOURCE = "queek-merchant";
export const APP_SOURCE = "queek-app";

export type AppOutboundMessage =
  | { source: typeof APP_SOURCE; type: "ready" }
  | { source: typeof APP_SOURCE; type: "resize"; height: number }
  | { source: typeof APP_SOURCE; type: "ack" };

export type AppInboundMessage =
  | { source: typeof DASHBOARD_SOURCE; type: "token"; token: string }
  | { source: typeof DASHBOARD_SOURCE; type: "resize-ack" };

export interface EmbedEvent {
  origin: string;
  data: unknown;
}

export interface EmbedEventTarget {
  addEventListener(type: "message", listener: (event: EmbedEvent) => void): void;
  removeEventListener(type: "message", listener: (event: EmbedEvent) => void): void;
}

export interface EmbedPostTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface FrameBridgeOptions {
  /** Exact dashboard origin (e.g. from the embed query or app config). */
  dashboardOrigin: string;
  target?: EmbedEventTarget;
  onToken?: (token: string) => void;
  onResizeAck?: () => void;
}

function isInbound(data: unknown): data is AppInboundMessage {
  if (!data || typeof data !== "object") {
    return false;
  }
  const message = data as Record<string, unknown>;
  if (message.source !== DASHBOARD_SOURCE || typeof message.type !== "string") {
    return false;
  }
  if (message.type === "token") {
    return typeof message.token === "string" && message.token.length > 0;
  }
  return message.type === "resize-ack";
}

/**
 * Listen for dashboard messages, accepting only the exact dashboard
 * origin. Returns an unsubscribe function. Never touches any secret.
 */
export function listenToDashboard(options: FrameBridgeOptions): () => void {
  const { dashboardOrigin, onToken, onResizeAck } = options;
  const target = options.target;
  const onMessage = (event: EmbedEvent) => {
    if (event.origin !== dashboardOrigin) {
      return;
    }
    if (!isInbound(event.data)) {
      return;
    }
    if (event.data.type === "token") {
      onToken?.(event.data.token);
    } else {
      onResizeAck?.();
    }
  };
  target?.addEventListener("message", onMessage);
  return () => target?.removeEventListener("message", onMessage);
}

/** Announce readiness to the exact dashboard origin — never `"*"`. */
export function sendReady(dashboardOrigin: string, target?: EmbedPostTarget): void {
  const message: AppOutboundMessage = { source: APP_SOURCE, type: "ready" };
  target?.postMessage(message, dashboardOrigin);
}
