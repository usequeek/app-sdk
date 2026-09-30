/**
 * Server-only entry (S4 stage 2): session-token verification needs the
 * per-installation `embsec_…` secret, which must never enter a browser
 * bundle. Import the verifier from `@usequeek/app-sdk/server`, never from
 * the main entry.
 */

export type {
  LaunchTokenClaims,
  SessionTokenBinding,
  SessionTokenClaims,
  SessionTokenFailure,
  VerifySessionTokenOptions,
} from "./session.js";
export {
  EMBED_SECRET_PREFIX,
  isBridgePurpose,
  SESSION_CLOCK_TOLERANCE_SECONDS,
  sessionTokenInstallationId,
  verifyLaunchToken,
  verifyLaunchTokenDetailed,
  verifySessionToken,
  verifySessionTokenDetailed,
} from "./session.js";
