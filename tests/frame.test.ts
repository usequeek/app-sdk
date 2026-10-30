import { describe, expect, it, vi } from "vitest";
import {
  APP_SOURCE,
  DASHBOARD_SOURCE,
  type EmbedEvent,
  listenToDashboard,
  onAiAction,
  parseInboundMessage,
  sendReady,
} from "../src/frame.js";

/** Browser-safe handshake client: origin-gated listener, exact-target sends. */

function fakeWindow() {
  const listeners = new Map<string, Set<(event: EmbedEvent) => void>>();
  return {
    addEventListener: (type: string, listener: (event: EmbedEvent) => void) => {
      const existing = listeners.get(type);
      if (existing) {
        existing.add(listener);
      } else {
        listeners.set(type, new Set([listener]));
      }
    },
    removeEventListener: (type: string, listener: (event: EmbedEvent) => void) => {
      listeners.get(type)?.delete(listener);
    },
    listeners,
  };
}

describe("listenToDashboard", () => {
  it("accepts only the exact dashboard origin", () => {
    const target = fakeWindow();
    const onToken = vi.fn();
    const stop = listenToDashboard({
      dashboardOrigin: "https://merchant.example.com",
      target,
      onToken,
    });
    const fire = (origin: string, data: unknown) => {
      for (const listener of target.listeners.get("message") ?? []) {
        listener({ origin, data });
      }
    };

    fire("https://merchant.example.com", { source: DASHBOARD_SOURCE, type: "token", token: "live" });
    fire("https://evil.example.com", { source: DASHBOARD_SOURCE, type: "token", token: "evil" });
    fire("https://merchant.example.com", { source: APP_SOURCE, type: "ready" });
    expect(onToken).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledWith("live");

    stop();
    fire("https://merchant.example.com", { source: DASHBOARD_SOURCE, type: "token", token: "late" });
    expect(onToken).toHaveBeenCalledTimes(1);
  });
});

describe("sendReady", () => {
  it("announces to the exact origin, never wildcard", () => {
    const postMessage = vi.fn();
    sendReady("https://merchant.example.com", { postMessage });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][1]).toBe("https://merchant.example.com");
    expect(postMessage.mock.calls[0][1]).not.toBe("*");
  });
});

describe("onAiAction", () => {
  const ORIGIN = "https://merchant.example.com";
  const message = {
    source: DASHBOARD_SOURCE,
    type: "ai-action",
    action: "block_date",
    values: { date: "2026-12-25" },
  };

  function setup() {
    const target = fakeWindow();
    const handler = vi.fn();
    const stop = onAiAction(handler, { dashboardOrigin: ORIGIN, target });
    const fire = (origin: string, data: unknown) => {
      for (const listener of target.listeners.get("message") ?? []) listener({ origin, data });
    };
    return { handler, stop, fire };
  }

  it("delivers the action from the dashboard origin only", () => {
    const { handler, stop, fire } = setup();
    fire(ORIGIN, message);
    fire("https://evil.example.com", message);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ action: "block_date", values: { date: "2026-12-25" } });
    stop();
    fire(ORIGIN, message);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores a wrong source and a malformed action or values", () => {
    const { handler, fire } = setup();
    fire(ORIGIN, { ...message, source: APP_SOURCE });
    fire(ORIGIN, { ...message, action: "Bad Key" });
    fire(ORIGIN, { ...message, values: [] });
    fire(ORIGIN, { ...message, values: { date: { nested: true } } });
    fire(ORIGIN, { ...message, values: { "bad key": "x" } });
    fire(ORIGIN, { ...message, values: { count: Number.POSITIVE_INFINITY } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps string, number and boolean values, drops an unset (null) input, caps text", () => {
    expect(
      parseInboundMessage({
        ...message,
        values: { date: "2026-12-25", days: 3, open: false, kind: null, note: "x".repeat(600) },
      }),
    ).toEqual({
      source: DASHBOARD_SOURCE,
      type: "ai-action",
      action: "block_date",
      values: { date: "2026-12-25", days: 3, open: false, note: "x".repeat(500) },
    });
  });

  it("refuses more values than an action may declare (8)", () => {
    const values = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`v${i}`, i]));
    expect(parseInboundMessage({ ...message, values })).toBeNull();
  });

  it("does not answer an ai-action as a resize-ack", () => {
    const target = fakeWindow();
    const onResizeAck = vi.fn();
    listenToDashboard({ dashboardOrigin: ORIGIN, target, onResizeAck });
    for (const listener of target.listeners.get("message") ?? []) listener({ origin: ORIGIN, data: message });
    expect(onResizeAck).not.toHaveBeenCalled();
  });
});
