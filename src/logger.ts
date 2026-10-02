/**
 * ONE structured logger for every Queek app: JSON lines on stdout (info and
 * below) / stderr (warn and above), with secret redaction baked in — never
 * opt-in per call site.
 *
 * Redacted: any field whose name looks like key/secret/token/password/auth/
 * credential/session, and any string shaped like an `sk_`/`pk_` key, a
 * `whsec_` secret, a `Bearer …` token, a bare RS256 JWT (`eyJ….….…`), or a
 * PEM private-key block — in field values AND in the message. What is left
 * in the logs is ids and p_ids, which is all an operator needs.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export type LogFields = Record<string, unknown>;

export interface LoggerOptions {
  service: string;
  level?: LogLevel;
  sink?: (line: string, level: LogLevel) => void;
}

const SENSITIVE_KEY_RE = /key|secret|token|passwd|password|auth|credential|session/i;
// Long opaque values Queek and friends mint: sk_live_/sk_test_, pk_*, whsec_*, Bearer …
// — plus the app credential shapes, which must NEVER reach logs: a whole PEM
// private-key block and a bare RS256 JWT (eyJ….….…, with or without a Bearer prefix).
const SECRET_VALUE_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|\b(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sk_(live|test)_[A-Za-z0-9_-]+|pk_(live|test)_[A-Za-z0-9_-]+|whsec_[A-Za-z0-9+/=_-]+|Bearer\s+[A-Za-z0-9._~+/-]+=*)\b/g;

export const REDACTED = "[redacted]";

function redactValue(key: string, value: unknown, depth: number): unknown {
  if (SENSITIVE_KEY_RE.test(key)) return REDACTED;
  return redactUnknown(value, depth);
}

function redactUnknown(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    SECRET_VALUE_RE.lastIndex = 0;
    return SECRET_VALUE_RE.test(value) ? value.replace(SECRET_VALUE_RE, REDACTED) : value;
  }
  if (Array.isArray(value)) {
    return depth <= 0 ? REDACTED : value.map((item) => redactUnknown(item, depth - 1));
  }
  if (typeof value === "object" && value !== null) {
    if (depth <= 0) return REDACTED;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = redactValue(key, entry, depth - 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVELS[options.level ?? (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info"] ?? 1;
  const sink =
    options.sink ??
    ((line: string, level: LogLevel) => {
      if (LEVELS[level] >= LEVELS.warn) process.stderr.write(`${line}\n`);
      else process.stdout.write(`${line}\n`);
    });

  const emit = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    if (LEVELS[level] < threshold) return;
    const redactedMessage = redactUnknown(message, 0);
    const redactedFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      redactedFields[key] = redactValue(key, value, 4);
    }
    sink(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        service: options.service,
        msg: redactedMessage,
        ...redactedFields,
      }),
      level,
    );
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
