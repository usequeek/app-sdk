import { describe, expect, it, vi } from "vitest";
import { APP_SOURCE, DASHBOARD_SOURCE, type EmbedEvent, listenToDashboard, sendReady } from "../src/frame.js";

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
