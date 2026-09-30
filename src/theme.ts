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

import { type EmbedEventTarget, listenToDashboard, type ThemeMode } from "./frame.js";

export type { ThemeMode };

/** Frame URL query param carrying the dashboard's resolved theme. */
export const THEME_PARAM = "theme";

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

/** Read the theme mode from a URL (`theme` param): exactly `dark` or `light`. */
export function getThemeModeFromUrl(href: string, param: string = THEME_PARAM): ThemeMode {
  try {
    const mode = new URL(href, "https://app.invalid").searchParams.get(param);
    return mode === "dark" ? "dark" : "light";
  } catch {
    return "light";
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
 * the `theme` URL param and sets `.dark` + `color-scheme` immediately —
 * a dark cold load never flashes light. No external dependency, no
 * dashboard round-trip.
 */
export function themeBootstrapScript(param: string = THEME_PARAM): string {
  const key = JSON.stringify(param);
  return (
    `try{var m=new URLSearchParams(location.search).get(${key});` +
    `var d=m==="dark";var e=document.documentElement;` +
    `e.classList.toggle("dark",d);e.style.colorScheme=d?"dark":"light"}catch(e){}`
  );
}

export interface ThemeListenerOptions {
  dashboardOrigin: string;
  target?: EmbedEventTarget;
  onChange?: (mode: ThemeMode) => void;
  doc?: ThemeDocument;
}

/**
 * Follow live dashboard theme changes: every bridge `theme{mode}` toggles
 * the `dark` class (and notifies `onChange`). Applies nothing on subscribe —
 * first paint is the bootstrap script / server render's job. Returns an
 * unsubscribe function.
 */
export function installThemeListener(options: ThemeListenerOptions): () => void {
  const { dashboardOrigin, target, onChange, doc } = options;
  return listenToDashboard({
    dashboardOrigin,
    target,
    onTheme: (theme) => {
      applyTheme(theme.mode, doc);
      onChange?.(theme.mode);
    },
  });
}
