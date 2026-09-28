/**
 * Server-only entry (S4 stage 2): session-token verification needs the
 * per-installation `embsec_…` secret, which must never enter a browser
 * bundle. Import the verifier from `@usequeek/app-sdk/server`, never from
 * the main entry.
 */

export type {
  SessionTokenBinding,
  SessionTokenClaims,
  SessionTokenFailure,
  VerifySessionTokenOptions,
} from "./session.js";
export {
  EMBED_SECRET_PREFIX,
  SESSION_CLOCK_TOLERANCE_SECONDS,
  verifySessionToken,
  verifySessionTokenDetailed,
} from "./session.js";
