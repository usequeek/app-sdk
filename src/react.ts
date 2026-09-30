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
import { applyTheme, getThemeModeFromUrl, type ThemeMode } from "./theme.js";

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
}

interface BridgeState {
  dashboardOrigin: string;
  postTarget: EmbedPostTarget | undefined;
  listenTarget: EmbedEventTarget | undefined;
  capabilities: string[];
  sdkVersion: string | undefined;
  getHref: () => string;
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
  postTarget?: EmbedPostTarget;
  listenTarget?: EmbedEventTarget;
  getHref?: () => string;
}

export function QueekProvider(props: QueekProviderProps): ReactNode {
  const { dashboardOrigin, children } = props;
  const win = useMemo(() => globalWindow(), []);
  const postTarget = props.postTarget ?? win?.parent;
  const listenTarget = props.listenTarget ?? (win as unknown as EmbedEventTarget | null) ?? undefined;
  const getHref = props.getHref ?? (() => win?.location.href ?? "");
  const capabilities = useMemo(() => props.capabilities ?? [], [props.capabilities]);
  const sdkVersion = props.sdkVersion;

  const modeRef = useRef<ThemeMode>(getThemeModeFromUrl(getHref()));
  const themeHandlers = useRef(new Set<(mode: ThemeMode) => void>());
  const titleHandlers = useRef(new Set<(id: string) => void>());
  const saveBarHandlers = useRef(new Set<(action: SaveBarAction) => void>());
  const navigateHandlers = useRef(new Set<(path: string) => void>());
  const pendingPick = useRef<PendingPick | null>(null);

  useEffect(() => {
    sendReady(dashboardOrigin, postTarget, { capabilities, sdkVersion });
    const stop = listenToDashboard({
      dashboardOrigin,
      target: listenTarget,
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
      onResourcePicked: (items) => {
        pendingPick.current?.resolve(items);
        pendingPick.current = null;
      },
      onResourcePickCancelled: () => {
        pendingPick.current?.resolve(null);
        pendingPick.current = null;
      },
    });
    return () => {
      pendingPick.current?.reject(new Error("QueekProvider unmounted"));
      pendingPick.current = null;
      stop();
    };
  }, [dashboardOrigin, postTarget, listenTarget, capabilities, sdkVersion]);

  const state = useMemo<BridgeState>(
    () => ({
      dashboardOrigin,
      postTarget,
      listenTarget,
      capabilities,
      sdkVersion,
      getHref,
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
        if (pendingPick.current !== null) {
          return Promise.reject(new Error("pickResource already in progress"));
        }
        sendPickResource(dashboardOrigin, postTarget, request);
        return new Promise<ResourceItem[] | null>((resolve, reject) => {
          pendingPick.current = { resolve, reject };
        });
      },
      currentMode: () => modeRef.current,
    }),
    [dashboardOrigin, postTarget, listenTarget, capabilities, sdkVersion, getHref],
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
  const { dashboardOrigin, postTarget } = bridge;
  const [mode, setMode] = useState<ThemeMode>(() => bridge.currentMode());

  useEffect(() => bridge.subscribeTheme(setMode), [bridge]);

  const toast = useCallback(
    (message: string, options?: ToastOptions) => {
      sendToast(dashboardOrigin, postTarget, message, options);
    },
    [dashboardOrigin, postTarget],
  );

  const saveBar = useMemo<SaveBarApi>(
    () => ({
      dirty: () => sendSaveBar(dashboardOrigin, postTarget, "dirty"),
      clean: () => sendSaveBar(dashboardOrigin, postTarget, "clean"),
      onAction: (handler) => bridge.subscribeSaveBarAction(handler),
    }),
    [bridge, dashboardOrigin, postTarget],
  );

  const title = useMemo<TitleApi>(
    () => ({
      set: (heading: string, actions?: TitleActions) =>
        sendTitle(dashboardOrigin, postTarget, heading, actions),
      onAction: (handler) => bridge.subscribeTitleAction(handler),
    }),
    [bridge, dashboardOrigin, postTarget],
  );

  const navigate = useMemo<NavigateApi>(
    () => ({
      report: (path: string) => sendNavigated(dashboardOrigin, postTarget, path),
      onNavigate: (handler) => bridge.subscribeNavigate(handler),
      open: (target: string) => sendOpen(dashboardOrigin, postTarget, target),
    }),
    [bridge, dashboardOrigin, postTarget],
  );

  const pickResource = useCallback((request: PickResourceRequest) => bridge.requestPick(request), [bridge]);

  return useMemo<QueekApi>(
    () => ({ toast, saveBar, title, navigate, pickResource, theme: { mode } }),
    [toast, saveBar, title, navigate, pickResource, mode],
  );
}
