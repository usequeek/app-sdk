/**
 * Framed-page bridge client, v1: the browser-safe half of the dashboard
 * bridge. Carries NO secret and performs NO verification — it only shapes
 * and addresses messages. The dashboard enforces origin+source binding and
 * mints tokens; the app's server verifies them via `./server`
 * (`verifySessionToken`).
 *
 * Compatible with the v0 protocol (`ready`/`token`/`resize`/`resize-ack`/
 * `ack`, sources `queek-app`/`queek-merchant`, exact-origin postMessage):
 * v1 only ADDS optional fields and new message types, and both directions
 * ignore unknown types.
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
/** Picker request ids are opaque correlation tokens, capped like action ids. */
export const MAX_REQUEST_ID_LENGTH = 64;

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
  requestId?: string;
}

export interface BridgeTheme {
  mode: ThemeMode;
  locale?: string;
  /**
   * The dashboard's own capabilities (e.g. `["pick-resource"]`), declared on
   * its handshake theme message. Absent on legacy dashboards — the app must
   * then assume the v0 set (ready/token/resize only). Documented in README
   * "Bridge handshake".
   */
  capabilities?: string[];
  /** The dashboard's bridge version (`"1"`); absent on legacy dashboards. */
  bridge?: string;
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
      requestId?: string;
    };

export type AppInboundMessage =
  | { source: typeof DASHBOARD_SOURCE; type: "token"; token: string }
  | { source: typeof DASHBOARD_SOURCE; type: "resize-ack" }
  | {
      source: typeof DASHBOARD_SOURCE;
      type: "theme";
      mode: ThemeMode;
      locale?: string;
      capabilities?: string[];
      bridge?: string;
    }
  | { source: typeof DASHBOARD_SOURCE; type: "title-action"; id: string }
  | { source: typeof DASHBOARD_SOURCE; type: "save-bar-action"; action: SaveBarAction }
  | { source: typeof DASHBOARD_SOURCE; type: "navigate"; path: string }
  | {
      source: typeof DASHBOARD_SOURCE;
      type: "resource-picked";
      items: ResourceItem[];
      requestId?: string;
    }
  | { source: typeof DASHBOARD_SOURCE; type: "resource-pick-cancelled"; requestId?: string };

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
  onResourcePicked?: (items: ResourceItem[], requestId?: string) => void;
  onResourcePickCancelled?: (requestId?: string) => void;
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

/**
 * Control characters never appear in legitimate bridge strings — and
 * browsers strip tab/newline inside schemes (`java\tscript:`), so reject
 * them outright. A char-code loop: regex control ranges trip the linter.
 */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Validate a title-bar action shape (no caps — `clipOutbound` is the single
 * place that truncates). Returns null for malformed defs.
 */
function parseTitleActionDef(value: unknown): TitleActionDef | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    return null;
  }
  if (typeof value.label !== "string" || value.label.length === 0) {
    return null;
  }
  if (value.tone !== undefined && value.tone !== "default" && value.tone !== "critical") {
    return null;
  }
  const def: TitleActionDef = { id: value.id, label: value.label };
  if (value.tone === "default" || value.tone === "critical") {
    def.tone = value.tone;
  }
  return def;
}

/** Opaque picker correlation token: kept capped, dropped when malformed. */
function optRequestId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return capText(value, MAX_REQUEST_ID_LENGTH);
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
  if (trimmed.length === 0 || hasControlChars(trimmed) || trimmed.includes("\\")) {
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

const ABSOLUTE_SCHEME = /^[a-z][a-z0-9+.-]*:/;

/**
 * The origin-free half of the open-target policy, shared by `clipOutbound`
 * (which has no origin) and `isAllowedOpenTarget`: no control characters
 * (browsers strip tab/newline inside schemes), no backslashes (browsers read
 * `\` as `/` for special schemes, so `https:\\evil` would escape), no
 * protocol-relative URLs, and any absolute URL must be https — which also
 * refuses javascript:/data:/vbscript:/file:.
 */
function isSafeOpenShape(target: unknown): target is string {
  if (typeof target !== "string" || target.length === 0 || target.length > MAX_TARGET_LENGTH) {
    return false;
  }
  const trimmed = target.trim();
  if (trimmed.length === 0 || hasControlChars(trimmed) || trimmed.includes("\\")) {
    return false;
  }
  if (trimmed.startsWith("//")) {
    return false;
  }
  return !ABSOLUTE_SCHEME.test(trimmed.toLowerCase()) || trimmed.toLowerCase().startsWith("https:");
}

/**
 * Open targets the app may ask the dashboard to open: a dashboard-relative
 * reference (resolves under the dashboard origin) or an absolute https URL
 * (the dashboard applies its own allowlist on top). Everything else is
 * refused — see `isSafeOpenShape`. The dashboard re-validates every target.
 */
export function isAllowedOpenTarget(target: unknown, dashboardOrigin: string): boolean {
  if (!isSafeOpenShape(target)) {
    return false;
  }
  try {
    const url = new URL(target.trim(), new URL(dashboardOrigin));
    return url.origin === new URL(dashboardOrigin).origin || url.protocol === "https:";
  } catch {
    return false;
  }
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
      // The dashboard handshake: its own capabilities, same caps as ours.
      if (data.capabilities !== undefined) {
        if (!Array.isArray(data.capabilities)) {
          return null;
        }
        message.capabilities = data.capabilities
          .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
          .slice(0, MAX_CAPABILITIES)
          .map((entry) => capText(entry, MAX_CAPABILITY_LENGTH));
      }
      if (data.bridge !== undefined) {
        if (typeof data.bridge !== "string" || data.bridge.length === 0) {
          return null;
        }
        message.bridge = capText(data.bridge, MAX_SDK_VERSION_LENGTH);
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
      const picked: Extract<AppInboundMessage, { type: "resource-picked" }> = {
        source: DASHBOARD_SOURCE,
        type: "resource-picked",
        items,
      };
      const pickedId = optRequestId(data.requestId);
      if (pickedId !== undefined) {
        picked.requestId = pickedId;
      }
      return picked;
    }
    case "resource-pick-cancelled": {
      const cancelled: Extract<AppInboundMessage, { type: "resource-pick-cancelled" }> = {
        source: DASHBOARD_SOURCE,
        type: "resource-pick-cancelled",
      };
      const cancelledId = optRequestId(data.requestId);
      if (cancelledId !== undefined) {
        cancelled.requestId = cancelledId;
      }
      return cancelled;
    }
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
 * Parse one app→dashboard message — this parser is what the dashboard runs,
 * so it must be trustworthy. Each branch validates the raw shape strictly
 * (malformed required fields and mistyped optionals reject the message with
 * null; malformed enum values reject too) and then delegates every cap and
 * allow-list to `clipOutbound`, the same sanitizer the senders use — one
 * copy of the policy, both directions. Unknown types return null — ignored,
 * never acted on. Pass the dashboard origin to also gate `open` targets via
 * `isAllowedOpenTarget`.
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
      if (data.capabilities !== undefined && !Array.isArray(data.capabilities)) {
        return null;
      }
      if (
        data.sdkVersion !== undefined &&
        (typeof data.sdkVersion !== "string" || data.sdkVersion.length === 0)
      ) {
        return null;
      }
      return clipOutbound({
        source: APP_SOURCE,
        type: "ready",
        capabilities: data.capabilities as string[] | undefined,
        sdkVersion: data.sdkVersion as string | undefined,
      });
    }
    case "resize":
      return typeof data.height === "number"
        ? clipOutbound({ source: APP_SOURCE, type: "resize", height: data.height })
        : null;
    case "ack":
      return { source: APP_SOURCE, type: "ack" };
    case "title": {
      if (typeof data.heading !== "string" || data.heading.length === 0) {
        return null;
      }
      if (data.secondaryActions !== undefined && !Array.isArray(data.secondaryActions)) {
        return null;
      }
      const out: AppOutboundMessage = { source: APP_SOURCE, type: "title", heading: data.heading };
      if (data.primaryAction !== undefined) {
        const primary = parseTitleActionDef(data.primaryAction);
        if (primary !== null) {
          out.primaryAction = primary;
        }
      }
      if (data.secondaryActions !== undefined) {
        out.secondaryActions = data.secondaryActions as TitleActionDef[];
      }
      return clipOutbound(out);
    }
    case "toast": {
      if (typeof data.message !== "string" || data.message.length === 0) {
        return null;
      }
      if (data.tone !== undefined && !isToastTone(data.tone)) {
        return null;
      }
      const out: AppOutboundMessage = { source: APP_SOURCE, type: "toast", message: data.message };
      if (data.tone !== undefined) {
        out.tone = data.tone;
      }
      if (data.durationMs !== undefined) {
        out.durationMs = data.durationMs as number;
      }
      return clipOutbound(out);
    }
    case "save-bar":
      return data.state === "dirty" || data.state === "clean"
        ? clipOutbound({ source: APP_SOURCE, type: "save-bar", state: data.state })
        : null;
    case "navigated":
      return typeof data.path === "string" && data.path.length > 0
        ? clipOutbound({ source: APP_SOURCE, type: "navigated", path: data.path })
        : null;
    case "open": {
      if (typeof data.target !== "string" || data.target.length === 0) {
        return null;
      }
      if (dashboardOrigin !== undefined && !isAllowedOpenTarget(data.target, dashboardOrigin)) {
        return null;
      }
      return clipOutbound({ source: APP_SOURCE, type: "open", target: data.target });
    }
    case "pick-resource": {
      if (data.resourceType !== "product") {
        return null;
      }
      if (data.multiple !== undefined && typeof data.multiple !== "boolean") {
        return null;
      }
      if (data.filter !== undefined && typeof data.filter !== "string") {
        return null;
      }
      if (data.selectionIds !== undefined && !Array.isArray(data.selectionIds)) {
        return null;
      }
      return clipOutbound({
        source: APP_SOURCE,
        type: "pick-resource",
        resourceType: "product",
        multiple: data.multiple as boolean | undefined,
        filter: data.filter as string | undefined,
        selectionIds: data.selectionIds as string[] | undefined,
        requestId: data.requestId as string | undefined,
      });
    }
    default:
      return null;
  }
}

/**
 * Post one app→dashboard message to the exact origin — never `"*"`.
 * Every message runs through `clipOutbound`; unpostable messages are
 * silently skipped.
 */
export function sendBridgeMessage(
  dashboardOrigin: string,
  target: EmbedPostTarget | undefined,
  message: AppOutboundMessage,
): void {
  const clipped = clipOutbound(message);
  if (clipped !== null) {
    target?.postMessage(clipped, dashboardOrigin);
  }
}

/**
 * Build the `ready` announcement (capped). The one shared `ready` builder:
 * `sendReady`, `installAuthFetch`'s refresh, and the React provider all
 * announce through it so the dashboard sees identical capabilities.
 */
export function buildReadyMessage(options?: ReadyOptions): AppOutboundMessage {
  return (
    clipOutbound({
      source: APP_SOURCE,
      type: "ready",
      capabilities: options?.capabilities,
      sdkVersion: options?.sdkVersion,
    }) ?? { source: APP_SOURCE, type: "ready" }
  );
}

/** Announce readiness to the exact dashboard origin — never `"*"`. */
export function sendReady(dashboardOrigin: string, target?: EmbedPostTarget, options?: ReadyOptions): void {
  sendBridgeMessage(dashboardOrigin, target, buildReadyMessage(options));
}

/**
 * Report the document height for auto-height. Builds raw — `clipOutbound`
 * (via `sendBridgeMessage`) clamps and drops non-finite asks.
 */
export function sendResize(
  dashboardOrigin: string,
  target: EmbedPostTarget | undefined,
  height: number,
): void {
  sendBridgeMessage(dashboardOrigin, target, { source: APP_SOURCE, type: "resize", height });
}

/** Delivery confirmation carrying no state (accepted, no further effect). */
export function sendAck(dashboardOrigin: string, target?: EmbedPostTarget): void {
  sendBridgeMessage(dashboardOrigin, target, { source: APP_SOURCE, type: "ack" });
}

/**
 * Drive the dashboard title bar (heading + up to 5 secondary actions).
 * Builds raw — malformed defs are dropped, caps applied downstream.
 */
export function sendTitle(
  dashboardOrigin: string,
  target: EmbedPostTarget | undefined,
  heading: string,
  actions?: { primaryAction?: TitleActionDef; secondaryActions?: TitleActionDef[] },
): void {
  const message: AppOutboundMessage = { source: APP_SOURCE, type: "title", heading };
  const primary = actions?.primaryAction !== undefined ? parseTitleActionDef(actions.primaryAction) : null;
  if (primary !== null) {
    message.primaryAction = primary;
  }
  if (actions?.secondaryActions !== undefined) {
    message.secondaryActions = actions.secondaryActions;
  }
  sendBridgeMessage(dashboardOrigin, target, message);
}

/** Ask the dashboard to show a toast. Builds raw — tone/duration sanitized downstream. */
export function sendToast(
  dashboardOrigin: string,
  target: EmbedPostTarget | undefined,
  message: string,
  options?: { tone?: ToastTone; durationMs?: number },
): void {
  const out: AppOutboundMessage = { source: APP_SOURCE, type: "toast", message };
  if (options?.tone !== undefined) {
    out.tone = options.tone;
  }
  if (options?.durationMs !== undefined) {
    out.durationMs = options.durationMs;
  }
  sendBridgeMessage(dashboardOrigin, target, out);
}

/** Show (dirty) or hide (clean) the dashboard save bar. Bad states are dropped downstream. */
export function sendSaveBar(
  dashboardOrigin: string,
  target: EmbedPostTarget | undefined,
  state: SaveBarState,
): void {
  sendBridgeMessage(dashboardOrigin, target, { source: APP_SOURCE, type: "save-bar", state });
}

/** Report an in-app move so the dashboard can mirror it in its URL. */
export function sendNavigated(
  dashboardOrigin: string,
  target: EmbedPostTarget | undefined,
  path: string,
): void {
  sendBridgeMessage(dashboardOrigin, target, { source: APP_SOURCE, type: "navigated", path });
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
  sendBridgeMessage(dashboardOrigin, target, { source: APP_SOURCE, type: "open", target: openTarget });
}

/**
 * Ask the dashboard to render its product picker (one at a time).
 * Builds raw — `clipOutbound` validates, caps, and drops non-product asks.
 */
export function sendPickResource(
  dashboardOrigin: string,
  target: EmbedPostTarget | undefined,
  request: PickResourceRequest,
): void {
  if (!isRecord(request)) {
    return;
  }
  sendBridgeMessage(dashboardOrigin, target, {
    source: APP_SOURCE,
    type: "pick-resource",
    resourceType: request.resourceType as "product",
    multiple: request.multiple as boolean | undefined,
    filter: request.filter as string | undefined,
    selectionIds: request.selectionIds as string[] | undefined,
    requestId: request.requestId as string | undefined,
  });
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
      case "theme": {
        const theme: BridgeTheme = { mode: message.mode };
        if (message.locale !== undefined) {
          theme.locale = message.locale;
        }
        if (message.capabilities !== undefined) {
          theme.capabilities = message.capabilities;
        }
        if (message.bridge !== undefined) {
          theme.bridge = message.bridge;
        }
        onTheme?.(theme);
        break;
      }
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
        onResourcePicked?.(message.items, message.requestId);
        break;
      case "resource-pick-cancelled":
        onResourcePickCancelled?.(message.requestId);
        break;
    }
  };
  target?.addEventListener("message", onMessage);
  return () => target?.removeEventListener("message", onMessage);
}

/** Validate a title-bar action shape, then cap its strings. */
function clipTitleActionDef(value: unknown): TitleActionDef | null {
  const def = parseTitleActionDef(value);
  if (def === null) {
    return null;
  }
  const out: TitleActionDef = {
    id: capText(def.id, MAX_ACTION_ID_LENGTH),
    label: capText(def.label, MAX_LABEL_LENGTH),
  };
  if (def.tone !== undefined) {
    out.tone = def.tone;
  }
  return out;
}

function clipSecondaryActions(value: unknown): TitleActionDef[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const rest: TitleActionDef[] = [];
  for (const raw of value.slice(0, MAX_SECONDARY_ACTIONS)) {
    const def = clipTitleActionDef(raw);
    if (def !== null) {
      rest.push(def);
    }
  }
  return rest.length > 0 ? rest : undefined;
}

/**
 * The single choke point for everything the app posts: caps every string,
 * allow-lists every enum, clamps every number, re-gates `open` targets
 * against scheme attacks. Returns null when the message is unpostable
 * (malformed required field, bad save-bar state, non-finite height,
 * blocked open target, non-product pick) — `sendBridgeMessage` skips null.
 */
export function clipOutbound(message: AppOutboundMessage): AppOutboundMessage | null {
  switch (message.type) {
    case "ready": {
      const out: AppOutboundMessage = { source: APP_SOURCE, type: "ready" };
      if (Array.isArray(message.capabilities)) {
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
      if (typeof message.height !== "number" || !Number.isFinite(message.height)) {
        return null;
      }
      return {
        source: APP_SOURCE,
        type: "resize",
        height: Math.min(MAX_RESIZE_HEIGHT, Math.max(0, Math.round(message.height))),
      };
    case "ack":
      return { source: APP_SOURCE, type: "ack" };
    case "title": {
      if (typeof message.heading !== "string" || message.heading.length === 0) {
        return null;
      }
      const out: AppOutboundMessage = {
        source: APP_SOURCE,
        type: "title",
        heading: capText(message.heading, MAX_HEADING_LENGTH),
      };
      if (message.primaryAction !== undefined) {
        const primary = clipTitleActionDef(message.primaryAction);
        if (primary !== null) {
          out.primaryAction = primary;
        }
      }
      const rest = clipSecondaryActions(message.secondaryActions);
      if (rest !== undefined) {
        out.secondaryActions = rest;
      }
      return out;
    }
    case "toast": {
      if (typeof message.message !== "string" || message.message.length === 0) {
        return null;
      }
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
      return message.state === "dirty" || message.state === "clean"
        ? { source: APP_SOURCE, type: "save-bar", state: message.state }
        : null;
    case "navigated":
      return typeof message.path === "string" && message.path.length > 0
        ? { source: APP_SOURCE, type: "navigated", path: capText(message.path, MAX_PATH_LENGTH) }
        : null;
    case "open": {
      if (typeof message.target !== "string" || message.target.length === 0) {
        return null;
      }
      if (!isSafeOpenShape(message.target)) {
        return null;
      }
      return { source: APP_SOURCE, type: "open", target: capText(message.target, MAX_TARGET_LENGTH) };
    }
    case "pick-resource": {
      if (message.resourceType !== "product") {
        return null;
      }
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
      if (message.selectionIds !== undefined && Array.isArray(message.selectionIds)) {
        const ids = message.selectionIds
          .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
          .slice(0, MAX_SELECTION_IDS)
          .map((entry) => capText(entry, MAX_SELECTION_ID_LENGTH));
        if (ids.length > 0) {
          out.selectionIds = ids;
        }
      }
      const requestId = optRequestId(message.requestId);
      if (requestId !== undefined) {
        out.requestId = requestId;
      }
      return out;
    }
  }
}
