import { describe, expect, it } from "vitest";
import {
  aiEditableSettingKeys,
  isReservedAiInputKey,
  MANIFEST_AI_ACTION_INPUT_TYPES,
  MANIFEST_AI_OUTPUT_TYPES,
  MANIFEST_AI_TOOL_INPUT_TYPES,
  MANIFEST_SETTING_TYPES,
  type ManifestAi,
  type ManifestSetting,
} from "../src/manifest.js";

describe("manifest settings", () => {
  const settings: ManifestSetting[] = [
    { key: "prep_minutes", label: "Prep time", type: "number", ai_editable: true },
    { key: "forward_to", label: "Forward orders to", type: "string" },
    { key: "mode", label: "Mode", type: "select", options: ["live", "test"], ai_editable: false },
    { key: "api_token", label: "API token", type: "secret", ai_editable: true },
  ];

  it("lists only the settings the manifest opts in, never a secret, and none by default", () => {
    expect(aiEditableSettingKeys(settings)).toEqual(["prep_minutes"]);
    expect(aiEditableSettingKeys(settings.filter((setting) => setting.ai_editable === undefined))).toEqual(
      [],
    );
  });

  it("knows the five setting types", () => {
    expect([...MANIFEST_SETTING_TYPES]).toEqual(["string", "secret", "number", "boolean", "select"]);
  });
});

describe("manifest ai section", () => {
  it("types a section like the one Queek reviews", () => {
    const ai: ManifestAi = {
      summary: "Bookings.",
      tools: [
        {
          key: "upcoming_bookings",
          description: "Upcoming bookings.",
          inputs: [{ key: "days", type: "integer", label: "Days ahead", min: 1, max: 30 }],
          output: { list: true, fields: [{ key: "date", type: "date" }] },
        },
      ],
      actions: [
        {
          key: "block_date",
          description: "Close a day.",
          page: "/admin/hours",
          inputs: [{ key: "note", type: "text", label: "Note", max_length: 200 }],
        },
      ],
    };
    expect(ai.tools?.[0]?.output.fields[0]?.type).toBe("date");
  });

  it("gives actions free text and tools none", () => {
    expect([...MANIFEST_AI_TOOL_INPUT_TYPES]).toEqual([
      "integer",
      "number",
      "boolean",
      "enum",
      "date",
      "order",
      "product",
    ]);
    expect([...MANIFEST_AI_ACTION_INPUT_TYPES]).toEqual([...MANIFEST_AI_TOOL_INPUT_TYPES, "text"]);
    expect([...MANIFEST_AI_OUTPUT_TYPES]).toEqual(["string", "integer", "number", "boolean", "date"]);
  });
});

describe("reserved AI input keys", () => {
  it("refuses the keys Queek signs or owns, and any logged_in_customer_ key", () => {
    for (const key of [
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
      "logged_in_customer_id",
    ]) {
      expect(isReservedAiInputKey(key)).toBe(true);
    }
    expect(isReservedAiInputKey("days")).toBe(false);
    expect(isReservedAiInputKey("order")).toBe(false);
  });
});
