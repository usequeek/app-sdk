/**
 * The `settings` entries of an app manifest (`manifest.json`, or `[[settings]]` in app.toml): the fields the merchant
 * fills in when installing or managing the app. Queek validates them on registration and on every settings write.
 */

/** The `type` of a manifest setting. A `secret` is write-only for the merchant and never shown back or exposed to an AI. */
export const MANIFEST_SETTING_TYPES = ["string", "secret", "number", "boolean", "select"] as const;
export type ManifestSettingType = (typeof MANIFEST_SETTING_TYPES)[number];

export interface ManifestSetting {
  /** `[a-z0-9_]{1,64}`, unique among the app's settings. */
  key: string;
  label: string;
  type: ManifestSettingType;
  required?: boolean;
  /** `select` only: the allowed values. */
  options?: string[];
  help?: string;
  /**
   * Opt in to the merchant's AI assistant changing this setting for them (default: it may not).
   *
   * Queek's AI assistant can change an installed third-party app's settings only when the manifest marks them
   * `ai_editable: true`; every other setting stays the merchant's to change in the dashboard, because anything the
   * assistant reads (a customer message, a review) could try to point a setting somewhere new (a forwarding URL, a
   * recipient email). Mark a setting only when a wrong value cannot move money, data or messages to a third party:
   * a prep time or a display mode, never a webhook, an address or an account. A `secret` is never AI-editable
   * (a manifest that says so is refused). Each AI change still needs the merchant's explicit confirmation.
   */
  ai_editable?: boolean;
}

/** The keys of the settings the AI assistant may change: opted in, and never a secret (the same rule Queek applies). */
export function aiEditableSettingKeys(settings: readonly ManifestSetting[]): string[] {
  return settings
    .filter((setting) => setting.ai_editable === true && setting.type !== "secret")
    .map((setting) => setting.key);
}

/**
 * The manifest's top-level `ai` section (beside `dashboard`): the small tools and actions Queek's AI assistant may use
 * for this app. It needs no scope and is part of the consent the merchant approves; adding or changing a tool or action
 * needs a fresh approval. Queek's AI never runs an app action: an action only OPENS the app's own `page` with the values
 * filled in, and the merchant checks them and saves there. Keys match `^[a-z][a-z0-9_]{0,39}$`.
 */
export interface ManifestAi {
  /** What the app is for, in your words (up to 1000 characters). Shown to the merchant, never trusted by the AI. */
  summary: string;
  /** Read tools (up to 20). Queek calls the app's proxy as `GET ai/{key}` signed with `surface=ai`. */
  tools?: ManifestAiTool[];
  /** Actions (up to 5; tools + actions up to 20). */
  actions?: ManifestAiAction[];
}

/** An input type a tool takes. `order` and `product` are Queek references, given as the store's integer `p_id`. */
export const MANIFEST_AI_TOOL_INPUT_TYPES = [
  "integer",
  "number",
  "boolean",
  "enum",
  "date",
  "order",
  "product",
] as const;
/** An action takes the tool types plus capped, URL-free free text. */
export const MANIFEST_AI_ACTION_INPUT_TYPES = [...MANIFEST_AI_TOOL_INPUT_TYPES, "text"] as const;
export type ManifestAiInputType = (typeof MANIFEST_AI_ACTION_INPUT_TYPES)[number];

/** The types of the fields a tool returns. */
export const MANIFEST_AI_OUTPUT_TYPES = ["string", "integer", "number", "boolean", "date"] as const;
export type ManifestAiOutputType = (typeof MANIFEST_AI_OUTPUT_TYPES)[number];

/**
 * Input keys Queek signs or owns on every call; a manifest declaring one is refused. Anything starting with
 * `MANIFEST_AI_RESERVED_INPUT_PREFIX` is reserved too.
 */
export const MANIFEST_AI_RESERVED_INPUT_KEYS = [
  "sig",
  "ts",
  "jti",
  "shop",
  "kid",
  "surface",
  "method",
  "body_sha256",
  "idempotency_key",
  "vendor_id",
  "installation_id",
  "order_id",
  "product_id",
  "tool",
  "actor",
  "actor_role",
] as const;
export const MANIFEST_AI_RESERVED_INPUT_PREFIX = "logged_in_customer_";

/** True when `key` may not be declared as an AI input. */
export function isReservedAiInputKey(key: string): boolean {
  return (
    (MANIFEST_AI_RESERVED_INPUT_KEYS as readonly string[]).includes(key) ||
    key.startsWith(MANIFEST_AI_RESERVED_INPUT_PREFIX)
  );
}

/** One input (up to 8 per tool or action). Reserved keys (`MANIFEST_AI_RESERVED_INPUT_KEYS`, `logged_in_customer_*`) are refused. */
export interface ManifestAiInput {
  key: string;
  type: ManifestAiInputType;
  /** Up to 80 characters. */
  label: string;
  required?: boolean;
  /** `enum` only: 1 to 30 values of up to 60 characters. */
  options?: string[];
  /** `integer` and `number` only. */
  min?: number;
  max?: number;
  /** `text` only (actions): 1 to 500, default 200. */
  max_length?: number;
}

export interface ManifestAiOutputField {
  key: string;
  type: ManifestAiOutputType;
}

export interface ManifestAiTool {
  key: string;
  /** Up to 512 characters. */
  description: string;
  inputs?: ManifestAiInput[];
  /** `list: true` means the tool answers `{ "rows": [...] }`, each row with these fields; anything else you return is dropped. */
  output: { list?: boolean; fields: ManifestAiOutputField[] };
}

export interface ManifestAiAction {
  key: string;
  /** Up to 512 characters. */
  description: string;
  /** A path under your merchant page's path prefix (like `extensions.nav` paths); the action needs a merchant page. */
  page: string;
  inputs?: ManifestAiInput[];
}
