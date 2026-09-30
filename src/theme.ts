/**
 * Dashboard-following theme (U7): dark when the dashboard is dark, light
 * when light, switching live. First load carries `theme=light|dark` in the
 * frame URL (dashboard `resolvedTheme`) so the app server-renders
 * `<html class="dark">` with no flash; live changes arrive as bridge
 * `theme{mode}` messages and toggle the `dark` class — shadcn's own
 * dark-mode mechanism.
 *
 * DOM-free by design (structural minimal types, like `frame.ts`): pass a
 * document in, or let the helpers use the global one when present.
 */

import {
  type EmbedEventTarget,
  type EmbedPostTarget,
  listenToDashboard,
  sendReady,
  type ThemeMode,
} from "./frame.js";

export type { ThemeMode };

/** Frame URL query param carrying the dashboard's resolved theme. */
export const THEME_PARAM = "theme";

/** sessionStorage key remembering the last live mode (bootstrap fallback). */
export const THEME_STORAGE_KEY = "queek.theme";

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function globalSessionStorage(): ThemeStorage | null {
  try {
    const storage = (globalThis as unknown as { sessionStorage?: ThemeStorage }).sessionStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

function globalParent(): unknown {
  return (globalThis as unknown as { window?: { parent?: unknown } }).window?.parent;
}

export interface ThemeDocumentElement {
  classList: { toggle(name: string, force?: boolean): void };
  style: { colorScheme: string };
}

export interface ThemeDocument {
  documentElement: ThemeDocumentElement;
}

function globalDocument(): ThemeDocument | null {
  const doc = (globalThis as unknown as { document?: ThemeDocument }).document;
  return doc?.documentElement !== undefined ? doc : null;
}

/** Remember the live mode (best-effort; storage may be denied in sandboxes). */
export function rememberThemeMode(mode: ThemeMode, storage?: ThemeStorage | null): void {
  const target = storage === undefined ? globalSessionStorage() : storage;
  if (target === null) {
    return;
  }
  try {
    target.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Denied storage must never break theming.
  }
}

function storedThemeMode(storage: ThemeStorage | null | undefined): ThemeMode | null {
  const target = storage === undefined ? globalSessionStorage() : storage;
  if (target === null || target === undefined) {
    return null;
  }
  try {
    const mode = target.getItem(THEME_STORAGE_KEY);
    return mode === "dark" || mode === "light" ? mode : null;
  } catch {
    return null;
  }
}

/**
 * Read the theme mode: the URL `theme` param wins; otherwise the remembered
 * live mode (an in-frame reload drops the param but keeps sessionStorage);
 * otherwise `light`.
 */
export function getThemeModeFromUrl(
  href: string,
  param: string = THEME_PARAM,
  storage?: ThemeStorage | null,
): ThemeMode {
  try {
    const params = new URL(href, "https://app.invalid").searchParams;
    if (params.has(param)) {
      return params.get(param) === "dark" ? "dark" : "light";
    }
  } catch {
    return "light";
  }
  return storedThemeMode(storage) ?? "light";
}

export interface ThemeUrlOptions {
  param?: string;
  /** Current href (defaults to the global window location). */
  getHref?: () => string;
  /** Replace the URL without navigating (defaults to history.replaceState). */
  replaceUrl?: (url: string) => void;
}

/**
 * Rewrite the `theme` URL param to the live mode (other params and the hash
 * are kept) so an in-frame reload's bootstrap reads the CURRENT mode, not the
 * stale one from the first load. Best-effort: never throws.
 */
export function syncThemeUrl(mode: ThemeMode, options: ThemeUrlOptions = {}): void {
  try {
    const win = (
      globalThis as unknown as {
        window?: {
          location: { href: string };
          history: { replaceState(d: unknown, u: string, url: string): void };
        };
      }
    ).window;
    const href = options.getHref !== undefined ? options.getHref() : win?.location.href;
    if (href === undefined) {
      return;
    }
    const param = options.param ?? THEME_PARAM;
    const url = new URL(href, "https://app.invalid");
    if (url.searchParams.get(param) === mode) {
      return;
    }
    url.searchParams.set(param, mode);
    const relative = `${url.pathname}${url.search}${url.hash}`;
    if (options.replaceUrl !== undefined) {
      options.replaceUrl(relative);
    } else {
      win?.history.replaceState(null, "", relative);
    }
  } catch {
    // A denied replaceState must not break theming.
  }
}

/**
 * Apply the mode: toggle `.dark` on `<html>` + set `color-scheme`
 * (shadcn's dark-mode mechanism). No-op without a document (SSR-safe).
 */
export function applyTheme(mode: ThemeMode, doc?: ThemeDocument): void {
  const target = doc ?? globalDocument();
  if (target === null || target === undefined) {
    return;
  }
  target.documentElement.classList.toggle("dark", mode === "dark");
  target.documentElement.style.colorScheme = mode;
}

/**
 * Tiny inline script (to place in `<head>` before first paint) that reads
 * the `theme` URL param — falling back to the mode remembered in
 * sessionStorage when the URL carries none (an in-frame reload) — and sets
 * `.dark` + `color-scheme` immediately, so a dark load never flashes light.
 * No external dependency, no dashboard round-trip.
 */
export function themeBootstrapScript(param: string = THEME_PARAM): string {
  const key = JSON.stringify(param);
  const storageKey = JSON.stringify(THEME_STORAGE_KEY);
  return (
    `try{var m=new URLSearchParams(location.search).get(${key});` +
    `if(m===null){try{m=sessionStorage.getItem(${storageKey})}catch(x){}}` +
    `else{try{sessionStorage.setItem(${storageKey},m==="dark"?"dark":"light")}catch(x){}}` +
    `var d=m==="dark";var e=document.documentElement;` +
    `e.classList.toggle("dark",d);e.style.colorScheme=d?"dark":"light"}catch(e){}`
  );
}

export interface ThemeListenerOptions {
  dashboardOrigin: string;
  target?: EmbedEventTarget;
  /**
   * Required `event.source` for theme messages. Defaults to the global
   * window's parent (the embedding dashboard); pass `null` to disable the
   * source check.
   */
  expectSource?: unknown;
  onChange?: (mode: ThemeMode) => void;
  doc?: ThemeDocument;
  /** postMessage target for the `ready` announcement (non-React apps need it to get the mode). */
  postTarget?: EmbedPostTarget;
  capabilities?: string[];
  sdkVersion?: string;
  storage?: ThemeStorage | null;
  /** URL access for the live `theme` param rewrite (default: the global window). */
  getHref?: () => string;
  replaceUrl?: (url: string) => void;
}

/**
 * Follow live dashboard theme changes: announces `ready` on subscribe (so a
 * non-React app gets the mode even after an in-frame reload), then every
 * bridge `theme{mode}` toggles the `dark` class, is remembered for the
 * bootstrap fallback, and notifies `onChange`. Applies nothing else on
 * subscribe — first paint is the bootstrap script / server render's job.
 * Returns an unsubscribe function.
 */
export function installThemeListener(options: ThemeListenerOptions): () => void {
  const { dashboardOrigin, target, onChange, doc, postTarget, capabilities, sdkVersion, storage } = options;
  const expectSource = options.expectSource !== undefined ? options.expectSource : globalParent();
  sendReady(dashboardOrigin, postTarget, { capabilities, sdkVersion });
  return listenToDashboard({
    dashboardOrigin,
    target,
    expectSource: expectSource ?? undefined,
    onTheme: (theme) => {
      applyTheme(theme.mode, doc);
      rememberThemeMode(theme.mode, storage);
      syncThemeUrl(theme.mode, { getHref: options.getHref, replaceUrl: options.replaceUrl });
      onChange?.(theme.mode);
    },
  });
}
