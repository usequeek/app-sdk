import type { QueekClient } from "./client.js";
import type { components } from "./merchant-schema.js";

/**
 * Installation-bound app writes (S3a): the setup notice, merchant alerts,
 * collected definitions and record submits. Every helper takes a
 * `QueekClient` built from the installation's own key — the backend
 * resolves the installation from that key, never from the body — and
 * returns the decoded `data` payload of the success envelope.
 *
 * Contracts: config/vendor_api_keys.php (Apps group + Forms proof path)
 * at queek_backend@c1fa1c31; request shapes below are the generated
 * `components` schemas from the same backend's merchant export.
 */

type Schemas = components["schemas"];

export interface SuccessEnvelope<T> {
  status: "success";
  message: string;
  data: T;
}

/** PUT app/setup — full-body write, so callers send the whole sheet every time. */
export type SetupNoticeStatus = "incomplete" | "complete";

export interface SetupNoticeItem {
  key: string;
  label: string;
  value: string;
  sensitive: boolean;
  copyable: boolean;
  instructions?: string;
}

export interface SetupNotice {
  status: SetupNoticeStatus;
  items: SetupNoticeItem[];
}

export type SetupNoticeBody = Schemas["UpdateAppSetupNoticeRequest"];

export async function setSetupNotice(
  client: QueekClient,
  notice: SetupNotice,
  options: { idempotencyKey?: string } = {},
): Promise<unknown> {
  const body: SetupNoticeBody = {
    status: notice.status,
    items: notice.items.map((item) => ({
      ...item,
      instructions: item.instructions ?? null,
    })),
  };
  const response = await client.request<SuccessEnvelope<unknown>>("PUT", "/app/setup", {
    body,
    idempotencyKey: options.idempotencyKey,
  });
  return response.data;
}

/** POST app/alerts — pages the merchant through the bell (in-app only). */
export type AlertSeverity = "info" | "warning" | "error";

export interface MerchantAlert {
  severity: AlertSeverity;
  title: string;
  message: string;
  dedupe_key?: string;
  meta?: string[];
}

export type AlertBody = Schemas["SendAppAlertRequest"];

export async function sendAlert(
  client: QueekClient,
  alert: MerchantAlert,
  options: { idempotencyKey?: string } = {},
): Promise<unknown> {
  const body: AlertBody = {
    ...alert,
    dedupe_key: alert.dedupe_key ?? null,
    meta: alert.meta ?? null,
  };
  const response = await client.request<SuccessEnvelope<unknown>>("POST", "/app/alerts", {
    body,
    idempotencyKey: options.idempotencyKey,
  });
  return response.data;
}

/** Collected definitions owned by the calling installation. */
export type CollectedField = Schemas["CollectedDefinitionRequest"]["fields"][number];

export interface CollectedDefinitionCreate {
  /** Must start with the installation's `app_{slug}_{p_id}_` prefix (403 otherwise). */
  type: string;
  name: string;
  description?: string;
  display_field: string;
  fields: CollectedField[];
}

export interface CollectedDefinitionUpdate {
  name?: string;
  description?: string;
  display_field?: string;
  fields?: CollectedField[];
}

/**
 * A collected definition as the Merchant API returns it
 * (MetaobjectDefinitionResource — Scramble cannot infer the shape, so it
 * is stated here from the resource's toArray at queek_backend@c1fa1c31:
 * p_id int, type, fields[] with the same field vocabulary as create).
 */
export interface CollectedDefinition {
  p_id: number;
  type: string;
  name: string;
  description: string | null;
  display_field: string;
  storefront_visible: boolean;
  has_pages: boolean;
  data_class: string;
  entry_cap_override: number | null;
  retention_days: number | null;
  fields: CollectedField[];
  created_at: string;
  updated_at: string;
}

export const collectedDefinitions = {
  /** GET collected-definitions — only the calling installation's own types. */
  async list(client: QueekClient): Promise<CollectedDefinition[]> {
    const response = await client.request<SuccessEnvelope<CollectedDefinition[]>>(
      "GET",
      "/collected-definitions",
    );
    return response.data;
  },

  /** POST collected-definitions — class forced collected, stamped to the installation. */
  async create(
    client: QueekClient,
    definition: CollectedDefinitionCreate,
    options: { idempotencyKey?: string } = {},
  ): Promise<CollectedDefinition> {
    const response = await client.request<SuccessEnvelope<CollectedDefinition>>(
      "POST",
      "/collected-definitions",
      { body: definition, idempotencyKey: options.idempotencyKey },
    );
    return response.data;
  },

  /** PATCH collected-definitions/{p_id} — the type itself is immutable. */
  async update(
    client: QueekClient,
    pId: number,
    patch: CollectedDefinitionUpdate,
    options: { idempotencyKey?: string } = {},
  ): Promise<CollectedDefinition> {
    const response = await client.request<SuccessEnvelope<CollectedDefinition>>(
      "PATCH",
      `/collected-definitions/${pId}`,
      { body: patch, idempotencyKey: options.idempotencyKey },
    );
    return response.data;
  },
};

/**
 * POST records — one record under the installation's own type.
 *
 * `values` is a `{field_key: value}` object (backend
 * FormsAppCollectedTest sends objects; the writer validates pairs). A
 * fresh Idempotency-Key is generated per call unless the caller passes
 * one — no two submits ever share a key.
 */
export async function createRecord(
  client: QueekClient,
  submit: { definition: string; values: Record<string, unknown> },
  options: { idempotencyKey?: string } = {},
): Promise<unknown> {
  const response = await client.request<SuccessEnvelope<unknown>>("POST", "/records", {
    body: submit,
    idempotencyKey: options.idempotencyKey,
  });
  return response.data;
}
