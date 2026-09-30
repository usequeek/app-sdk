"use client";

/**
 * Optional React bindings for `@usequeek/app-sdk` (U2).
 *
 * Import from `@usequeek/app-sdk/react` (requires the optional `react`
 * peer) — a thin layer built ONLY on the framework-free core (`frame.js` /
 * `theme.js`): `<QueekProvider>` owns one bridge subscription, and
 * `useQueek()` exposes `{ toast, saveBar, title, navigate, pickResource,
 * theme }` over it.
 *
 * No JSX in this file (the build stays plain `tsc`, no `jsx` flag).
 */

import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type BridgeTheme,
  type EmbedEventTarget,
  type EmbedPostTarget,
  listenToDashboard,
  type PickResourceRequest,
  type ResourceItem,
  type SaveBarAction,
  type SaveBarState,
  sendNavigated,
  sendOpen,
  sendPickResource,
  sendReady,
  sendSaveBar,
  sendTitle,
  sendToast,
  type TitleActionDef,
  type ToastTone,
} from "./frame.js";
import { applyTheme, getThemeModeFromUrl, rememberThemeMode, type ThemeMode } from "./theme.js";

/** A pick with no dashboard answer settles after this long (never deadlocks). */
export const PICK_TIMEOUT_MS = 5 * 60 * 1000;

export type {
  BridgeTheme,
  PickResourceRequest,
  ResourceItem,
  SaveBarAction,
  SaveBarState,
  ThemeMode,
  TitleActionDef,
  ToastTone,
};

export interface ToastOptions {
  tone?: ToastTone;
  durationMs?: number;
}

export interface TitleActions {
  primaryAction?: TitleActionDef;
  secondaryActions?: TitleActionDef[];
}

export interface SaveBarApi {
  dirty: () => void;
  clean: () => void;
  onAction: (handler: (action: SaveBarAction) => void) => () => void;
}

export interface TitleApi {
  set: (heading: string, actions?: TitleActions) => void;
  onAction: (handler: (id: string) => void) => () => void;
}

export interface NavigateApi {
  /** Report an in-app move so the dashboard mirrors it in its URL. */
  report: (path: string) => void;
  /** Follow dashboard-driven moves (back/forward, sidebar). */
  onNavigate: (handler: (path: string) => void) => () => void;
  /** Ask the dashboard to open a dashboard path or https URL. */
  open: (target: string) => void;
}

export interface ThemeApi {
  mode: ThemeMode;
}

export interface QueekApi {
  toast: (message: string, options?: ToastOptions) => void;
  saveBar: SaveBarApi;
  title: TitleApi;
  navigate: NavigateApi;
  /** Resolve with the picked items, or null when the merchant cancels. */
  pickResource: (request: PickResourceRequest) => Promise<ResourceItem[] | null>;
  theme: ThemeApi;
}

interface PendingPick {
  resolve: (items: ResourceItem[] | null) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BridgeState {
  dashboardOrigin: string;
  /** Run a core sender against the latest wiring (never a stale render's). */
  post: (send: (dashboardOrigin: string, target: EmbedPostTarget | undefined) => void) => void;
  subscribeTheme: (handler: (mode: ThemeMode) => void) => () => void;
  subscribeTitleAction: (handler: (id: string) => void) => () => void;
  subscribeSaveBarAction: (handler: (action: SaveBarAction) => void) => () => void;
  subscribeNavigate: (handler: (path: string) => void) => () => void;
  requestPick: (request: PickResourceRequest) => Promise<ResourceItem[] | null>;
  currentMode: () => ThemeMode;
}

const QueekBridgeContext = createContext<BridgeState | null>(null);

interface GlobalWindow {
  location: { href: string };
  parent?: EmbedPostTarget;
  addEventListener(type: "message", listener: (event: { origin: string; data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { origin: string; data: unknown }) => void): void;
}

function globalWindow(): GlobalWindow | null {
  const win = (globalThis as unknown as { window?: GlobalWindow }).window;
  return win?.location !== undefined ? (win ?? null) : null;
}

export interface QueekProviderProps {
  dashboardOrigin: string;
  children?: ReactNode;
  /** Declared in `ready{capabilities}` so old dashboards degrade gracefully. */
  capabilities?: string[];
  sdkVersion?: string;
  /**
   * The dashboard's own capabilities when known. When present without
   * `pick-resource`, `pickResource` rejects at once instead of waiting on a
   * dashboard that will never answer (old-dashboard case).
   */
  dashboardCapabilities?: string[];
  postTarget?: EmbedPostTarget;
  listenTarget?: EmbedEventTarget;
  getHref?: () => string;
  /**
   * Required `event.source` for bridge messages. Defaults to the global
   * window's parent when present; pass `null` to disable the source check.
   */
  expectSource?: unknown;
}

export function QueekProvider(props: QueekProviderProps): ReactNode {
  const { dashboardOrigin, children, sdkVersion } = props;
  const win = useMemo(() => globalWindow(), []);
  // Latest wiring lives in a ref: parent re-renders (inline arrays, fresh
  // closures) must NOT resubscribe the bridge or re-announce ready.
  const configRef = useRef({
    postTarget: props.postTarget ?? win?.parent,
    listenTarget: props.listenTarget ?? (win as unknown as EmbedEventTarget | null) ?? undefined,
    getHref: props.getHref ?? (() => win?.location.href ?? ""),
    capabilities: props.capabilities ?? [],
    dashboardCapabilities: props.dashboardCapabilities,
    expectSource: props.expectSource !== undefined ? props.expectSource : (win?.parent ?? undefined),
  });
  configRef.current = {
    postTarget: props.postTarget ?? win?.parent,
    listenTarget: props.listenTarget ?? (win as unknown as EmbedEventTarget | null) ?? undefined,
    getHref: props.getHref ?? (() => win?.location.href ?? ""),
    capabilities: props.capabilities ?? [],
    dashboardCapabilities: props.dashboardCapabilities,
    expectSource: props.expectSource !== undefined ? props.expectSource : (win?.parent ?? undefined),
  };
  // Capabilities keyed by content: a new inline array with the same entries
  // keeps the subscription (and the single ready) stable.
  const capKey = JSON.stringify(props.capabilities ?? []);

  // "light" until the mount effect reads the URL — the first render must
  // match SSR to avoid a hydration mismatch.
  const modeRef = useRef<ThemeMode>("light");
  const themeHandlers = useRef(new Set<(mode: ThemeMode) => void>());
  const titleHandlers = useRef(new Set<(id: string) => void>());
  const saveBarHandlers = useRef(new Set<(action: SaveBarAction) => void>());
  const navigateHandlers = useRef(new Set<(path: string) => void>());
  const pendingPick = useRef<PendingPick | null>(null);

  const settlePick = useCallback((value: ResourceItem[] | null) => {
    const pending = pendingPick.current;
    pendingPick.current = null;
    if (pending !== null) {
      clearTimeout(pending.timer);
      pending.resolve(value);
    }
  }, []);

  const failPick = useCallback((error: Error) => {
    const pending = pendingPick.current;
    pendingPick.current = null;
    if (pending !== null) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }, []);

  useEffect(() => {
    const config = configRef.current;
    sendReady(dashboardOrigin, config.postTarget, { capabilities: config.capabilities, sdkVersion });
    // Sync the URL theme after mount (render stayed SSR-safe "light").
    const initial = getThemeModeFromUrl(config.getHref());
    if (initial !== modeRef.current) {
      modeRef.current = initial;
      applyTheme(initial);
      for (const handler of themeHandlers.current) {
        handler(initial);
      }
    }
    const stop = listenToDashboard({
      dashboardOrigin,
      target: config.listenTarget,
      expectSource: config.expectSource ?? undefined,
      onTheme: (theme) => {
        modeRef.current = theme.mode;
        applyTheme(theme.mode);
        for (const handler of themeHandlers.current) {
          handler(theme.mode);
        }
      },
      onTitleAction: (id) => {
        for (const handler of titleHandlers.current) {
          handler(id);
        }
      },
      onSaveBarAction: (action) => {
        for (const handler of saveBarHandlers.current) {
          handler(action);
        }
      },
      onNavigate: (path) => {
        for (const handler of navigateHandlers.current) {
          handler(path);
        }
      },
      onResourcePicked: (items) => settlePick(items),
      onResourcePickCancelled: () => settlePick(null),
    });
    return () => {
      failPick(new Error("QueekProvider unmounted"));
      stop();
    };
  }, [dashboardOrigin, capKey, sdkVersion, settlePick, failPick]);

  const state = useMemo<BridgeState>(
    () => ({
      dashboardOrigin,
      post: (send) => send(dashboardOrigin, configRef.current.postTarget),
      subscribeTheme: (handler) => {
        themeHandlers.current.add(handler);
        return () => {
          themeHandlers.current.delete(handler);
        };
      },
      subscribeTitleAction: (handler) => {
        titleHandlers.current.add(handler);
        return () => {
          titleHandlers.current.delete(handler);
        };
      },
      subscribeSaveBarAction: (handler) => {
        saveBarHandlers.current.add(handler);
        return () => {
          saveBarHandlers.current.delete(handler);
        };
      },
      subscribeNavigate: (handler) => {
        navigateHandlers.current.add(handler);
        return () => {
          navigateHandlers.current.delete(handler);
        };
      },
      requestPick: (request) => {
        // Validate BEFORE registering: an invalid request rejects at once
        // and can never deadlock a later pick.
        if (
          typeof request !== "object" ||
          request === null ||
          (request as { resourceType?: unknown }).resourceType !== "product"
        ) {
          return Promise.reject(new Error("pickResource supports product resources only"));
        }
        if (pendingPick.current !== null) {
          return Promise.reject(new Error("pickResource already in progress"));
        }
        const supported = configRef.current.dashboardCapabilities;
        if (supported !== undefined && !supported.includes("pick-resource")) {
          return Promise.reject(new Error("dashboard does not support pick-resource"));
        }
        const config = configRef.current;
        sendPickResource(dashboardOrigin, config.postTarget, request);
        return new Promise<ResourceItem[] | null>((resolve, reject) => {
          const timer = setTimeout(() => {
            failPick(new Error("pickResource timed out"));
          }, PICK_TIMEOUT_MS);
          (timer as unknown as { unref?: () => void }).unref?.();
          pendingPick.current = { resolve, reject, timer };
        });
      },
      currentMode: () => modeRef.current,
    }),
    [dashboardOrigin, capKey, sdkVersion],
  );

  return createElement(QueekBridgeContext.Provider, { value: state }, children);
}

function useBridge(): BridgeState {
  const bridge = useContext(QueekBridgeContext);
  if (bridge === null) {
    throw new Error("useQueek must be used inside <QueekProvider>");
  }
  return bridge;
}

/** Bridge actions + live theme over the framework-free core. */
export function useQueek(): QueekApi {
  const bridge = useBridge();
  const { post } = bridge;
  // "light" first (matches SSR); the effect below syncs the live mode, so a
  // dark URL theme never causes a hydration mismatch.
  const [mode, setMode] = useState<ThemeMode>("light");

  useEffect(() => {
    setMode(bridge.currentMode());
    return bridge.subscribeTheme(setMode);
  }, [bridge]);

  const toast = useCallback(
    (message: string, options?: ToastOptions) => {
      post((origin, target) => sendToast(origin, target, message, options));
    },
    [post],
  );

  const saveBar = useMemo<SaveBarApi>(
    () => ({
      dirty: () => post((origin, target) => sendSaveBar(origin, target, "dirty")),
      clean: () => post((origin, target) => sendSaveBar(origin, target, "clean")),
      onAction: (handler) => bridge.subscribeSaveBarAction(handler),
    }),
    [bridge, post],
  );

  const title = useMemo<TitleApi>(
    () => ({
      set: (heading: string, actions?: TitleActions) =>
        post((origin, target) => sendTitle(origin, target, heading, actions)),
      onAction: (handler) => bridge.subscribeTitleAction(handler),
    }),
    [bridge, post],
  );

  const navigate = useMemo<NavigateApi>(
    () => ({
      report: (path: string) => post((origin, target) => sendNavigated(origin, target, path)),
      onNavigate: (handler) => bridge.subscribeNavigate(handler),
      open: (openTarget: string) => post((origin, target) => sendOpen(origin, target, openTarget)),
    }),
    [bridge, post],
  );

  const pickResource = useCallback((request: PickResourceRequest) => bridge.requestPick(request), [bridge]);

  return useMemo<QueekApi>(
    () => ({ toast, saveBar, title, navigate, pickResource, theme: { mode } }),
    [toast, saveBar, title, navigate, pickResource, mode],
  );
}
