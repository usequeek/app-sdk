import { describe, expect, it, vi } from "vitest";
import { createQueekClient } from "../src/client.js";
import { collectedDefinitions, createRecord, sendAlert, setSetupNotice } from "../src/collected.js";

const API_BASE = "https://api.usequeek.com/api/v1/merchant";
const API_KEY = "sk_test_installation_key";

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const request = url instanceof Request ? url : new Request(url.toString(), init);
    const merged: RequestInit = {
      method: request.method,
      headers: request.headers,
      body: init?.body ?? (await request.text().catch(() => undefined)),
      signal: init?.signal ?? request.signal,
    };
    return handler(request.url, merged);
  });
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function client(fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  return createQueekClient({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl });
}

function ok(data: unknown) {
  return jsonResponse(200, { status: "success", message: "ok", data });
}

describe("installation-bound app writes", () => {
  it("PUTs the full setup sheet to /app/setup (status + items)", async () => {
    const seen: { body?: unknown } = {};
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toBe(`${API_BASE}/app/setup`);
      expect(init.method).toBe("PUT");
      seen.body = JSON.parse(String(init.body));
      return ok({ setup: {} });
    });
    await setSetupNotice(client(fetchImpl), {
      status: "complete",
      items: [
        {
          key: "form_link",
          label: "Contact form link",
          value: "https://forms.apps.usequeek.com/f/abc",
          sensitive: false,
          copyable: true,
          instructions: "Share this link with customers.",
        },
      ],
    });
    expect(seen.body).toEqual({
      status: "complete",
      items: [
        {
          key: "form_link",
          label: "Contact form link",
          value: "https://forms.apps.usequeek.com/f/abc",
          sensitive: false,
          copyable: true,
          instructions: "Share this link with customers.",
        },
      ],
    });
  });

  it("POSTs alerts with severity/title/message and an optional dedupe key", async () => {
    const seen: { body?: unknown } = {};
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toBe(`${API_BASE}/app/alerts`);
      seen.body = JSON.parse(String(init.body));
      return ok({});
    });
    await sendAlert(client(fetchImpl), {
      severity: "warning",
      title: "Form full",
      message: "The contact type hit its record cap.",
      dedupe_key: "forms:cap:7",
    });
    expect(seen.body).toMatchObject({ severity: "warning", dedupe_key: "forms:cap:7" });
  });

  it("lists, creates and patches collected definitions on the installation's types", async () => {
    const calls: Array<{ method?: string; url: string; body?: unknown }> = [];
    const fetchImpl = mockFetch((url, init) => {
      const raw = init.body === undefined ? "" : String(init.body);
      calls.push({ method: init.method, url, body: raw === "" ? undefined : JSON.parse(raw) });
      return ok([]);
    });
    const c = client(fetchImpl);
    await collectedDefinitions.list(c);
    await collectedDefinitions.create(c, {
      type: "app_forms_3_contact",
      name: "Contact form",
      display_field: "name",
      fields: [
        { key: "name", name: "Name", type: "single_line_text", required: true },
        { key: "email", name: "Email", type: "single_line_text", required: true },
        { key: "message", name: "Message", type: "multi_line_text" },
      ],
    });
    await collectedDefinitions.update(c, 9, { description: "Website contact form" });
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "GET /api/v1/merchant/collected-definitions",
      "POST /api/v1/merchant/collected-definitions",
      "PATCH /api/v1/merchant/collected-definitions/9",
    ]);
    expect(calls[1]?.body).toMatchObject({ type: "app_forms_3_contact", display_field: "name" });
  });

  it("POSTs records as {definition, values} objects with a fresh Idempotency-Key per submit", async () => {
    const keys: Array<string | null> = [];
    const fetchImpl = mockFetch((url, init) => {
      expect(new URL(url).pathname).toBe("/api/v1/merchant/records");
      keys.push(new Headers(init.headers).get("Idempotency-Key"));
      return jsonResponse(201, { status: "success", message: "Collected record submitted", data: {} });
    });
    const c = client(fetchImpl);
    await createRecord(c, { definition: "app_forms_3_contact", values: { name: "Adaeze" } });
    await createRecord(c, { definition: "app_forms_3_contact", values: { name: "Bola" } });
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(keys).size).toBe(2);
  });
});
