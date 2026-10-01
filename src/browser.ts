/**
 * Plain-browser entry for `@usequeek/app-sdk` (Booking fix): the embedded-app
 * bridge plus `installAuthFetch`, with ZERO Node-only modules.
 *
 * Import from `@usequeek/app-sdk/browser` in any browser bundle (Vite,
 * Rollup, esbuild, …). Importing the same helpers from the MAIN entry pulls
 * the whole barrel (`app-auth` → `node:crypto`, `store` → `pg`, …) and breaks
 * browser builds — the main entry stays the server/universal entry on
 * purpose (see README "Which entry do I import?").
 *
 * This module re-exports ONLY modules with no Node dependencies:
 * `auth-fetch.js`, `frame.js`, `theme.js` (each imports at most each other).
 * The scope consent-link builder (`buildScopeRequestLink`) is deliberately
 * NOT here: it lives in `scopes.ts`, which imports `app-auth`/`client`/
 * `store` (`node:crypto`, `pg`, `node:sqlite`) — open consent links from the
 * browser with `sendOpen` instead (see README "Scopes").
 *
 * `tests/browser.test.ts` statically walks this file's transitive imports
 * and fails if any of them ever gains a `node:*` / `pg` / `hono` / `jose` /
 * `react` dependency, so this entry can never silently regress.
 */

export {
  type AuthFetchOptions,
  BRIDGE_TOKEN_TIMEOUT_MS,
  type InstalledAuth,
  installAuthFetch,
  LAUNCH_TOKEN_PARAM,
  readLaunchToken,
  stripLaunchToken,
} from "./auth-fetch.js";
export {
  APP_SOURCE,
  type AppInboundMessage,
  type AppOutboundMessage,
  BRIDGE_VERSION,
  type BridgeTheme,
  DASHBOARD_SOURCE,
  type EmbedEvent,
  type EmbedEventTarget,
  type EmbedPostTarget,
  type FrameBridgeOptions,
  listenToDashboard,
  type PickResourceRequest,
  type ReadyOptions,
  type ResourceItem,
  type SaveBarAction,
  type SaveBarState,
  sendNavigated,
  sendOpen,
  sendPickResource,
  sendReady,
  sendSaveBar,
  sendTitle,
  type ThemeMode,
  type TitleActionDef,
} from "./frame.js";
// NOTE: ThemeMode comes from ./frame.js only — theme.js merely re-exports
// it, so listing it here too would be ambiguous.
export {
  applyTheme,
  getThemeModeFromUrl,
  installThemeListener,
  rememberThemeMode,
  syncThemeUrl,
  THEME_PARAM,
  THEME_STORAGE_KEY,
  type ThemeDocument,
  type ThemeDocumentElement,
  type ThemeListenerOptions,
  type ThemeStorage,
  type ThemeUrlOptions,
  themeBootstrapScript,
} from "./theme.js";
