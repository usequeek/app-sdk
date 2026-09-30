/**
 * Framed-page bridge client, v1 (U2): the browser-safe half of the
 * dashboard bridge. Carries NO secret and performs NO verification — it only
 * shapes and addresses messages. The dashboard (queek-merchant) enforces
 * origin+source binding and mints tokens; the app backend verifies them via
 * `./server` (`verifySessionToken`).
 *
 * Byte-compatible with today's protocol (`ready`/`token`/`resize`/
 * `resize-ack`/`ack`, sources `queek-app`/`queek-merchant`, exact-origin
 * postMessage): v1 only ADDS optional fields and new message types, and both
 * directions ignore unknown types.
 *
 * DOM-free by design (structural minimal types): the app passes its own
 * window/parent in, so this module needs no DOM lib and stays import-safe
 * in edge runtimes.
 */

export const DASHBOARD_SOURCE = "queek-merchant";
export const APP_SOURCE = "queek-app";

/** Bridge protocol version this SDK speaks. */
export const BRIDGE_VERSION = "1";

/** Client-side length caps: every outbound string is truncated to its cap. */
export const MAX_HEADING_LENGTH = 200;
export const MAX_LABEL_LENGTH = 80;
export const MAX_ACTION_ID_LENGTH = 64;
export const MAX_TOAST_LENGTH = 500;
export const MAX_PATH_LENGTH = 2048;
export const MAX_TARGET_LENGTH = 2048;
export const MAX_LOCALE_LENGTH = 32;
export const MAX_SDK_VERSION_LENGTH = 32;
export const MAX_CAPABILITY_LENGTH = 64;
export const MAX_CAPABILITIES = 32;
export const MAX_SECONDARY_ACTIONS = 5;
export const MAX_SELECTION_IDS = 100;
export const MAX_SELECTION_ID_LENGTH = 128;
export const MAX_RESOURCE_TITLE_LENGTH = 300;
export const MAX_IMAGE_URL_LENGTH = 2048;
export const MAX_FILTER_LENGTH = 64;
export const MAX_TOAST_DURATION_MS = 10_000;
export const MAX_RESIZE_HEIGHT = 10_000;
/** Dashboard answers carry at most this many picked items; the rest is dropped. */
export const MAX_PICKED_ITEMS = 100;

export type ThemeMode = "light" | "dark";
export type SaveBarState = "dirty" | "clean";
export type SaveBarAction = "save" | "discard";
export type ToastTone = "info" | "success" | "warning" | "critical";
export type TitleActionTone = "default" | "critical";

export interface TitleActionDef {
  id: string;
  label: string;
  tone?: TitleActionTone;
}

export interface ResourceItem {
  p_id: string;
  title: string;
  image?: string;
}

export interface PickResourceRequest {
  resourceType: "product";
  multiple?: boolean;
  filter?: string;
  selectionIds?: string[];
}

export interface BridgeTheme {
  mode: ThemeMode;
  locale?: string;
}

export type AppOutboundMessage =
  | { source: typeof APP_SOURCE; type: "ready"; capabilities?: string[]; sdkVersion?: string }
  | { source: typeof APP_SOURCE; type: "resize"; height: number }
  | { source: typeof APP_SOURCE; type: "ack" }
  | {
      source: typeof APP_SOURCE;
      type: "title";
      heading: string;
      primaryAction?: TitleActionDef;
      secondaryActions?: TitleActionDef[];
    }
  | { source: typeof APP_SOURCE; type: "toast"; message: string; tone?: ToastTone; durationMs?: number }
  | { source: typeof APP_SOURCE; type: "save-bar"; state: SaveBarState }
  | { source: typeof APP_SOURCE; type: "navigated"; path: string }
  | { source: typeof APP_SOURCE; type: "open"; target: string }
  | {
      source: typeof APP_SOURCE;
      type: "pick-resource";
      resourceType: "product";
      multiple?: boolean;
      filter?: string;
      selectionIds?: string[];
    };

export type AppInboundMessage =
  | { source: typeof DASHBOARD_SOURCE; type: "token"; token: string }
  | { source: typeof DASHBOARD_SOURCE; type: "resize-ack" }
  | { source: typeof DASHBOARD_SOURCE; type: "theme"; mode: ThemeMode; locale?: string }
  | { source: typeof DASHBOARD_SOURCE; type: "title-action"; id: string }
  | { source: typeof DASHBOARD_SOURCE; type: "save-bar-action"; action: SaveBarAction }
  | { source: typeof DASHBOARD_SOURCE; type: "navigate"; path: string }
  | { source: typeof DASHBOARD_SOURCE; type: "resource-picked"; items: ResourceItem[] }
  | { source: typeof DASHBOARD_SOURCE; type: "resource-pick-cancelled" };

export interface EmbedEvent {
  origin: string;
  data: unknown;
  /** The sender window (`MessageEvent.source`); checked when `expectSource` is set. */
  source?: unknown;
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
  /**
   * When set, only events whose `source` is this exact value are accepted
   * (normally the embedding window — an origin check alone does not bind
   * WHICH frame sent the message).
   */
  expectSource?: unknown;
  onToken?: (token: string) => void;
  onResizeAck?: () => void;
  onTheme?: (theme: BridgeTheme) => void;
  onTitleAction?: (id: string) => void;
  onSaveBarAction?: (action: SaveBarAction) => void;
  onNavigate?: (path: string) => void;
  onResourcePicked?: (items: ResourceItem[]) => void;
  onResourcePickCancelled?: () => void;
}

export interface ReadyOptions {
  capabilities?: string[];
  sdkVersion?: string;
}

function isRecord(data: unknown): data is Record<string, unknown> {
  return !!data && typeof data === "object";
}

/** Truncate an outbound string client-side. Non-strings become "". */
export function capText(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : "";
  return text.length > max ? text.slice(0, max) : text;
}

function optText(value: unknown, max: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return capText(value, max);
}

function reqText(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return capText(value, max);
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark";
}

function parseTitleActionDef(value: unknown): TitleActionDef | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = reqText(value.id, MAX_ACTION_ID_LENGTH);
  const label = reqText(value.label, MAX_LABEL_LENGTH);
  if (id === null || label === null) {
    return null;
  }
  if (value.tone !== undefined && value.tone !== "default" && value.tone !== "critical") {
    return null;
  }
  const def: TitleActionDef = { id, label };
  if (value.tone === "default" || value.tone === "critical") {
    def.tone = value.tone;
  }
  return def;
}

function parseResourceItem(value: unknown): ResourceItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const pId = reqText(value.p_id, MAX_SELECTION_ID_LENGTH);
  const title = reqText(value.title, MAX_RESOURCE_TITLE_LENGTH);
  if (pId === null || title === null) {
    return null;
  }
  const item: ResourceItem = { p_id: pId, title };
  // Optional decoration: kept only when it is an https URL or a
  // dashboard-relative path — never javascript:/data:/etc.
  if (typeof value.image === "string" && isAllowedImageUrl(value.image)) {
    item.image = capText(value.image.trim(), MAX_IMAGE_URL_LENGTH);
  }
  return item;
}

/** Image URLs the dashboard may attach to picked items. */
export function isAllowedImageUrl(image: unknown): boolean {
  if (typeof image !== "string" || image.length === 0 || image.length > MAX_IMAGE_URL_LENGTH) {
    return false;
  }
  const trimmed = image.trim();
  if (trimmed.length === 0 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  if (/^(javascript|data|vbscript|file):/.test(lower)) {
    return false;
  }
  if (trimmed.startsWith("//")) {
    return false;
  }
  if (trimmed.startsWith("/")) {
    return true;
  }
  try {
    return new URL(trimmed).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Open targets the app may ask the dashboard to open: a dashboard-relative
 * reference (resolves under the dashboard origin) or an absolute https URL
 * (the dashboard applies its own allowlist on top). Everything else —
 * javascript:/data:/vbscript:/file:, protocol-relative, non-https, control
 * characters — is refused. The dashboard re-validates every target.
 */
export function isAllowedOpenTarget(target: unknown, dashboardOrigin: string): boolean {
  if (typeof target !== "string" || target.length === 0 || target.length > MAX_TARGET_LENGTH) {
    return false;
  }
  const trimmed = target.trim();
  if (trimmed.length === 0 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  if (/^(javascript|data|vbscript|file):/.test(lower)) {
    return false;
  }
  if (trimmed.startsWith("//")) {
    return false;
  }
  let base: URL;
  try {
    base = new URL(dashboardOrigin);
  } catch {
    return false;
  }
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return false;
  }
  if (url.origin === base.origin) {
    return true;
  }
  return url.protocol === "https:";
}

/**
 * Parse one dashboard→app message. Returns null for anything else —
 * wrong source, unknown type, malformed shape — so unknown types are
 * silently ignored (forward compatibility, both directions).
 */
export function parseInboundMessage(data: unknown): AppInboundMessage | null {
  if (!isRecord(data)) {
    return null;
  }
  if (data.source !== DASHBOARD_SOURCE || typeof data.type !== "string") {
    return null;
  }
  switch (data.type) {
    case "token":
      // Opaque credential: never truncated, never logged.
      return typeof data.token === "string" && data.token.length > 0
        ? { source: DASHBOARD_SOURCE, type: "token", token: data.token }
        : null;
    case "resize-ack":
      return { source: DASHBOARD_SOURCE, type: "resize-ack" };
    case "theme": {
      if (!isThemeMode(data.mode)) {
        return null;
      }
      const message: AppInboundMessage = { source: DASHBOARD_SOURCE, type: "theme", mode: data.mode };
      const locale = optText(data.locale, MAX_LOCALE_LENGTH);
      if (locale !== undefined) {
        message.locale = locale;
      }
      return message;
    }
    case "title-action": {
      const id = reqText(data.id, MAX_ACTION_ID_LENGTH);
      return id === null ? null : { source: DASHBOARD_SOURCE, type: "title-action", id };
    }
    case "save-bar-action":
      return data.action === "save" || data.action === "discard"
        ? { source: DASHBOARD_SOURCE, type: "save-bar-action", action: data.action }
        : null;
    case "navigate": {
      const path = reqText(data.path, MAX_PATH_LENGTH);
      return path === null ? null : { source: DASHBOARD_SOURCE, type: "navigate", path };
    }
    case "resource-picked": {
      if (!Array.isArray(data.items)) {
        return null;
      }
      const items: ResourceItem[] = [];
      for (const raw of data.items.slice(0, MAX_PICKED_ITEMS)) {
        const item = parseResourceItem(raw);
        if (item === null) {
          return null;
        }
        items.push(item);
      }
      return { source: DASHBOARD_SOURCE, type: "resource-picked", items };
    }
    case "resource-pick-cancelled":
      return { source: DASHBOARD_SOURCE, type: "resource-pick-cancelled" };
    default:
      return null;
  }
}

function isToastTone(value: unknown): value is ToastTone {
  return value === "info" || value === "success" || value === "warning" || value === "critical";
}

function clampDurationMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.min(MAX_TOAST_DURATION_MS, Math.floor(value));
}

/**
 * Parse one app→dashboard message with the same per-type validation + caps
 * the senders apply — this parser is what the dashboard runs, so it must be
 * trustworthy: malformed required fields reject the message (null), malformed
 * optional fields are dropped, and every string is length-capped.
 * Unknown types return null — ignored, never acted on. Pass the dashboard
 * origin to also gate `open` targets via `isAllowedOpenTarget`.
 */
export function parseOutboundMessage(data: unknown, dashboardOrigin?: string): AppOutboundMessage | null {
  if (!isRecord(data)) {
    return null;
  }
  if (data.source !== APP_SOURCE || typeof data.type !== "string") {
    return null;
  }
  switch (data.type) {
    case "ready": {
      const out: AppOutboundMessage = { source: APP_SOURCE, type: "ready" };
      if (data.capabilities !== undefined) {
        if (!Array.isArray(data.capabilities)) {
          return null;
        }
        out.capabilities = data.capabilities
          .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
          .slice(0, MAX_CAPABILITIES)
          .map((entry) => capText(entry, MAX_CAPABILITY_LENGTH));
      }
      if (data.sdkVersion !== undefined) {
        if (typeof data.sdkVersion !== "string" || data.sdkVersion.length === 0) {
          return null;
        }
        out.sdkVersion = capText(data.sdkVersion, MAX_SDK_VERSION_LENGTH);
      }
      return out;
    }
    case "resize":
      return typeof data.height === "number" && Number.isFinite(data.height)
        ? {
            source: APP_SOURCE,
            type: "resize",
            height: Math.min(MAX_RESIZE_HEIGHT, Math.max(0, Math.round(data.height))),
          }
        : null;
    case "ack":
      return { source: APP_SOURCE, type: "ack" };
    case "title": {
      if (typeof data.heading !== "string" || data.heading.length === 0) {
        return null;
      }
      const out: AppOutboundMessage = {
        source: APP_SOURCE,
        type: "title",
        heading: capText(data.heading, MAX_HEADING_LENGTH),
      };
      if (data.primaryAction !== undefined) {
        const primary = parseTitleActionDef(data.primaryAction);
        if (primary !== null) {
          out.primaryAction = primary;
        }
      }
      if (data.secondaryActions !== undefined) {
        if (!Array.isArray(data.secondaryActions)) {
          return null;
        }
        const rest: TitleActionDef[] = [];
        for (const raw of data.secondaryActions.slice(0, MAX_SECONDARY_ACTIONS)) {
          const def = parseTitleActionDef(raw);
          if (def !== null) {
            rest.push(def);
          }
        }
        if (rest.length > 0) {
          out.secondaryActions = rest;
        }
      }
      return out;
    }
    case "toast": {
      if (typeof data.message !== "string" || data.message.length === 0) {
        return null;
      }
      const out: AppOutboundMessage = {
        source: APP_SOURCE,
        type: "toast",
        message: capText(data.message, MAX_TOAST_LENGTH),
      };
      if (data.tone !== undefined) {
        if (!isToastTone(data.tone)) {
          return null;
        }
        out.tone = data.tone;
      }
      const durationMs = clampDurationMs(data.durationMs);
      if (durationMs !== undefined) {
        out.durationMs = durationMs;
      }
      return out;
    }
    case "save-bar":
      return data.state === "dirty" || data.state === "clean"
        ? { source: APP_SOURCE, type: "save-bar", state: data.state }
        : null;
    case "navigated":
      return typeof data.path === "string" && data.path.length > 0
        ? { source: APP_SOURCE, type: "navigated", path: capText(data.path, MAX_PATH_LENGTH) }
        : null;
    case "open": {
      if (typeof data.target !== "string" || data.target.length === 0) {
        return null;
      }
      if (dashboardOrigin !== undefined && !isAllowedOpenTarget(data.target, dashboardOrigin)) {
        return null;
      }
      return { source: APP_SOURCE, type: "open", target: capText(data.target, MAX_TARGET_LENGTH) };
    }
    case "pick-resource": {
      if (data.resourceType !== "product") {
        return null;
      }
      const out: AppOutboundMessage = { source: APP_SOURCE, type: "pick-resource", resourceType: "product" };
      if (data.multiple !== undefined) {
        if (typeof data.multiple !== "boolean") {
          return null;
        }
        out.multiple = data.multiple;
      }
      if (data.filter !== undefined) {
        if (typeof data.filter !== "string") {
          return null;
        }
        const filter = optText(data.filter, MAX_FILTER_LENGTH);
        if (filter !== undefined) {
          out.filter = filter;
        }
      }
      if (data.selectionIds !== undefined) {
        if (!Array.isArray(data.selectionIds)) {
          return null;
        }
        const ids = data.selectionIds
          .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
          .slice(0, MAX_SELECTION_IDS)
          .map((entry) => capText(entry, MAX_SELECTION_ID_LENGTH));
        if (ids.length > 0) {
          out.selectionIds = ids;
        }
      }
      return out;
    }
    default:
      return null;
  }
}

/** Post one app→dashboard message to the exact origin — never `"*"`. */
export function sendBridgeMessage(
  dashboardOrigin: string,
  target: EmbedPostTarget | undefined,
  message: AppOutboundMessage,
): void {
  target?.postMessage(clipOutbound(message), dashboardOrigin);
}

/** Announce readiness to the exact dashboard origin — never `"*"`. */
export function sendReady(dashboardOrigin: string, target?: EmbedPostTarget, options?: ReadyOptions): void {
  const message: AppOutboundMessage = { source: APP_SOURCE, type: "ready" };
  if (options?.capabilities !== undefined) {
    message.capabilities = options.capabilities
      .filter((entry) => typeof entry === "string" && entry.length > 0)
      .slice(0, MAX_CAPABILITIES)
      .map((entry) => capText(entry, MAX_CAPABILITY_LENGTH));
  }
  const sdkVersion = optText(options?.sdkVersion, MAX_SDK_VERSION_LENGTH);
  if (sdkVersion !== undefined) {
    message.sdkVersion = sdkVersion;
  }
  target?.postMessage(message, dashboardOrigin);
}

/** Report the document height for auto-height; non-finite asks are dropped. */
export function sendResize(
  dashboardOrigin: string,
  target: EmbedPostTarget | undefined,
  height: number,
): void {
  if (typeof height !== "number" || !Number.isFinite(height)) {
    return;
  }
  sendBridgeMessage(dashboardOrigin, target, {
    source: APP_SOURCE,
    type: "resize",
    height: Math.min(MAX_RESIZE_HEIGHT, Math.max(0, Math.round(height))),
  });
}

/** Delivery confirmation with no state — accepted and ignored by decision. */
export function sendAck(dashboardOrigin: string, target?: EmbedPostTarget): void {
  sendBridgeMessage(dashboardOrigin, target, { source: APP_SOURCE, type: "ack" });
}

/** Drive the dashboard title bar (heading + up to 5 secondary actions). */
export function sendTitle(
  dashboardOrigin: string,
  target: EmbedPostTarget | undefined,
  heading: string,
  actions?: { primaryAction?: TitleActionDef; secondaryActions?: TitleActionDef[] },
): void {
  const message: AppOutboundMessage = {
    source: APP_SOURCE,
    type: "title",
    heading: capText(heading, MAX_HEADING_LENGTH),
  };
  const primary = actions?.primaryAction !== undefined ? parseTitleActionDef(actions.primaryAction) : null;
  if (primary !== null) {
    message.primaryAction = primary;
  }
  if (actions?.secondaryActions !== undefined) {
    const rest: TitleActionDef[] = [];
    for (const raw of actions.secondaryActions.slice(0, MAX_SECONDARY_ACTIONS)) {
      const def = parseTitleActionDef(raw);
      if (def !== null) {
        rest.push(def);
      }
    }
    if (rest.length > 0) {
      message.secondaryActions = rest;
    }
  }
  sendBridgeMessage(dashboardOrigin, target, message);
}

/** Ask the dashboard to show a toast. */
export function sendToast(
  dashboardOrigin: string,
  target: EmbedPostTarget | undefined,
  message: string,
  options?: { tone?: ToastTone; durationMs?: number },
): void {
  const out: AppOutboundMessage = {
    source: APP_SOURCE,
    type: "toast",
    message: capText(message, MAX_TOAST_LENGTH),
  };
  if (
    options?.tone === "info" ||
    options?.tone === "success" ||
    options?.tone === "warning" ||
    options?.tone === "critical"
  ) {
    out.tone = options.tone;
  }
  if (
    typeof options?.durationMs === "number" &&
    Number.isFinite(options.durationMs) &&
    options.durationMs > 0
  ) {
    out.durationMs = Math.min(MAX_TOAST_DURATION_MS, Math.floor(options.durationMs));
  }
  sendBridgeMessage(dashboardOrigin, target, out);
}

/** Show (dirty) or hide (clean) the dashboard save bar. */
export function sendSaveBar(
  dashboardOrigin: string,
  target: EmbedPostTarget | undefined,
  state: SaveBarState,
): void {
  if (state !== "dirty" && state !== "clean") {
    return;
  }
  sendBridgeMessage(dashboardOrigin, target, { source: APP_SOURCE, type: "save-bar", state });
}

/** Report an in-app move so the dashboard can mirror it in its URL (U2b). */
export function sendNavigated(
  dashboardOrigin: string,
  target: EmbedPostTarget | undefined,
  path: string,
): void {
  if (typeof path !== "string" || path.length === 0) {
    return;
  }
  sendBridgeMessage(dashboardOrigin, target, {
    source: APP_SOURCE,
    type: "navigated",
    path: capText(path, MAX_PATH_LENGTH),
  });
}

/**
 * Ask the dashboard to open a dashboard path or https URL (sandbox-safe).
 * Anything `isAllowedOpenTarget` refuses is never posted — the dashboard
 * re-validates every target before acting on it.
 */
export function sendOpen(
  dashboardOrigin: string,
  target: EmbedPostTarget | undefined,
  openTarget: string,
): void {
  if (!isAllowedOpenTarget(openTarget, dashboardOrigin)) {
    return;
  }
  sendBridgeMessage(dashboardOrigin, target, {
    source: APP_SOURCE,
    type: "open",
    target: capText(openTarget, MAX_TARGET_LENGTH),
  });
}

/** Ask the dashboard to render its product picker (one at a time). */
export function sendPickResource(
  dashboardOrigin: string,
  target: EmbedPostTarget | undefined,
  request: PickResourceRequest,
): void {
  if (!isRecord(request) || request.resourceType !== "product") {
    return;
  }
  const message: AppOutboundMessage = { source: APP_SOURCE, type: "pick-resource", resourceType: "product" };
  if (request.multiple !== undefined) {
    message.multiple = request.multiple === true;
  }
  const filter = optText(request.filter, MAX_FILTER_LENGTH);
  if (filter !== undefined) {
    message.filter = filter;
  }
  if (request.selectionIds !== undefined && Array.isArray(request.selectionIds)) {
    const ids = request.selectionIds
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .slice(0, MAX_SELECTION_IDS)
      .map((entry) => capText(entry, MAX_SELECTION_ID_LENGTH));
    if (ids.length > 0) {
      message.selectionIds = ids;
    }
  }
  sendBridgeMessage(dashboardOrigin, target, message);
}

/**
 * Listen for dashboard messages, accepting only the exact dashboard
 * origin. Unknown types are ignored. Returns an unsubscribe function.
 * Never touches any secret.
 */
export function listenToDashboard(options: FrameBridgeOptions): () => void {
  const {
    dashboardOrigin,
    onToken,
    onResizeAck,
    onTheme,
    onTitleAction,
    onSaveBarAction,
    onNavigate,
    onResourcePicked,
    onResourcePickCancelled,
  } = options;
  const target = options.target;
  const expectSource = options.expectSource;
  const onMessage = (event: EmbedEvent) => {
    if (event.origin !== dashboardOrigin) {
      return;
    }
    if (expectSource !== undefined && event.source !== expectSource) {
      return;
    }
    const message = parseInboundMessage(event.data);
    if (message === null) {
      return;
    }
    switch (message.type) {
      case "token":
        onToken?.(message.token);
        break;
      case "resize-ack":
        onResizeAck?.();
        break;
      case "theme":
        onTheme?.(
          message.locale === undefined
            ? { mode: message.mode }
            : { mode: message.mode, locale: message.locale },
        );
        break;
      case "title-action":
        onTitleAction?.(message.id);
        break;
      case "save-bar-action":
        onSaveBarAction?.(message.action);
        break;
      case "navigate":
        onNavigate?.(message.path);
        break;
      case "resource-picked":
        onResourcePicked?.(message.items);
        break;
      case "resource-pick-cancelled":
        onResourcePickCancelled?.();
        break;
    }
  };
  target?.addEventListener("message", onMessage);
  return () => target?.removeEventListener("message", onMessage);
}

/**
 * Re-apply the client-side caps to an outbound message (the senders already
 * cap at construction; this is the single choke point that guarantees no
 * uncapped string reaches `postMessage`).
 */
export function clipOutbound(message: AppOutboundMessage): AppOutboundMessage {
  switch (message.type) {
    case "ready": {
      const out: AppOutboundMessage = { source: APP_SOURCE, type: "ready" };
      if (message.capabilities !== undefined) {
        out.capabilities = message.capabilities
          .filter((entry) => typeof entry === "string" && entry.length > 0)
          .slice(0, MAX_CAPABILITIES)
          .map((entry) => capText(entry, MAX_CAPABILITY_LENGTH));
      }
      const sdkVersion = optText(message.sdkVersion, MAX_SDK_VERSION_LENGTH);
      if (sdkVersion !== undefined) {
        out.sdkVersion = sdkVersion;
      }
      return out;
    }
    case "resize":
      return {
        ...message,
        height: Math.min(MAX_RESIZE_HEIGHT, Math.max(0, Math.round(message.height))),
      };
    case "ack":
      return message;
    case "title": {
      const out: AppOutboundMessage = {
        source: APP_SOURCE,
        type: "title",
        heading: capText(message.heading, MAX_HEADING_LENGTH),
      };
      const primary = message.primaryAction === undefined ? null : parseTitleActionDef(message.primaryAction);
      if (primary !== null) {
        out.primaryAction = primary;
      }
      if (message.secondaryActions !== undefined) {
        const rest: TitleActionDef[] = [];
        for (const raw of message.secondaryActions.slice(0, MAX_SECONDARY_ACTIONS)) {
          const def = parseTitleActionDef(raw);
          if (def !== null) {
            rest.push(def);
          }
        }
        if (rest.length > 0) {
          out.secondaryActions = rest;
        }
      }
      return out;
    }
    case "toast": {
      const out: AppOutboundMessage = {
        source: APP_SOURCE,
        type: "toast",
        message: capText(message.message, MAX_TOAST_LENGTH),
      };
      if (message.tone !== undefined && isToastTone(message.tone)) {
        out.tone = message.tone;
      }
      const durationMs = clampDurationMs(message.durationMs);
      if (durationMs !== undefined) {
        out.durationMs = durationMs;
      }
      return out;
    }
    case "save-bar":
      return message;
    case "navigated":
      return { ...message, path: capText(message.path, MAX_PATH_LENGTH) };
    case "open":
      return { ...message, target: capText(message.target, MAX_TARGET_LENGTH) };
    case "pick-resource": {
      const out: AppOutboundMessage = {
        source: APP_SOURCE,
        type: "pick-resource",
        resourceType: "product",
      };
      if (message.multiple !== undefined && typeof message.multiple === "boolean") {
        out.multiple = message.multiple;
      }
      const filter = optText(message.filter, MAX_FILTER_LENGTH);
      if (filter !== undefined) {
        out.filter = filter;
      }
      if (message.selectionIds !== undefined) {
        const ids = message.selectionIds
          .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
          .slice(0, MAX_SELECTION_IDS)
          .map((entry) => capText(entry, MAX_SELECTION_ID_LENGTH));
        if (ids.length > 0) {
          out.selectionIds = ids;
        }
      }
      return out;
    }
  }
}
