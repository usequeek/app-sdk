import { describe, expect, it, vi } from "vitest";
import {
  APP_SOURCE,
  type AppInboundMessage,
  DASHBOARD_SOURCE,
  type EmbedEvent,
  listenToDashboard,
  parseInboundMessage,
  parseOutboundMessage,
  sendAck,
  sendBridgeMessage,
  sendNavigated,
  sendOpen,
  sendPickResource,
  sendReady,
  sendResize,
  sendSaveBar,
  sendTitle,
  sendToast,
} from "../src/frame.js";

/** Bridge v1: typed unions both directions, caps, origin/source gates. */

function fakeTargets() {
  const listeners = new Map<string, Set<(event: EmbedEvent) => void>>();
  const posts: { message: unknown; origin: string }[] = [];
  const listenTarget = {
    addEventListener: (type: string, listener: (event: EmbedEvent) => void) => {
      const existing = listeners.get(type) ?? new Set<(event: EmbedEvent) => void>();
      existing.add(listener);
      listeners.set(type, existing);
    },
    removeEventListener: (type: string, listener: (event: EmbedEvent) => void) => {
      listeners.get(type)?.delete(listener);
    },
  };
  const postTarget = {
    postMessage: (message: unknown, origin: string) => {
      posts.push({ message, origin });
    },
  };
  const fire = (origin: string, data: unknown) => {
    for (const listener of listeners.get("message") ?? []) {
      listener({ origin, data });
    }
  };
  return { listenTarget, postTarget, posts, fire };
}

const ORIGIN = "https://merchant.example.com";

describe("byte compatibility with today's protocol", () => {
  it("bare ready/resize/ack still parse and send unchanged", () => {
    expect(parseOutboundMessage({ source: APP_SOURCE, type: "ready" })).toEqual({
      source: APP_SOURCE,
      type: "ready",
    });
    expect(parseOutboundMessage({ source: APP_SOURCE, type: "resize", height: 420 })).toEqual({
      source: APP_SOURCE,
      type: "resize",
      height: 420,
    });
    expect(parseInboundMessage({ source: DASHBOARD_SOURCE, type: "token", token: "t" })).toEqual({
      source: DASHBOARD_SOURCE,
      type: "token",
      token: "t",
    });
    expect(parseInboundMessage({ source: DASHBOARD_SOURCE, type: "resize-ack" })).toEqual({
      source: DASHBOARD_SOURCE,
      type: "resize-ack",
    });
    const { postTarget, posts } = fakeTargets();
    sendReady(ORIGIN, postTarget);
    sendAck(ORIGIN, postTarget);
    expect(posts[0]).toEqual({ message: { source: APP_SOURCE, type: "ready" }, origin: ORIGIN });
    expect(posts[1]).toEqual({ message: { source: APP_SOURCE, type: "ack" }, origin: ORIGIN });
  });

  it("ready gains optional capabilities + sdkVersion, additively", () => {
    const { postTarget, posts } = fakeTargets();
    sendReady(ORIGIN, postTarget, { capabilities: ["title", "toast"], sdkVersion: "0.5.1" });
    expect(posts[0]?.message).toEqual({
      source: APP_SOURCE,
      type: "ready",
      capabilities: ["title", "toast"],
      sdkVersion: "0.5.1",
    });
  });

  it("never posts to wildcard", () => {
    const { postTarget, posts } = fakeTargets();
    sendBridgeMessage(ORIGIN, postTarget, { source: APP_SOURCE, type: "ack" });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.origin).toBe(ORIGIN);
    expect(posts[0]?.origin).not.toBe("*");
  });
});

describe("unknown types are ignored", () => {
  it.each([
    { source: DASHBOARD_SOURCE, type: "teleport", path: "/x" },
    { source: DASHBOARD_SOURCE, type: "token" },
    { source: DASHBOARD_SOURCE, type: "token", token: "" },
    { source: DASHBOARD_SOURCE, type: "theme", mode: "sepia" },
    { source: DASHBOARD_SOURCE, type: "save-bar-action", action: "snooze" },
    { source: DASHBOARD_SOURCE, type: "resource-picked", items: [{ p_id: "1" }] },
    { source: APP_SOURCE, type: "ready" },
    { source: "queek-evil", type: "token", token: "x" },
    null,
    "ready",
    42,
  ])("parseInboundMessage drops %j", (data) => {
    expect(parseInboundMessage(data)).toBeNull();
  });

  it.each([
    { source: APP_SOURCE, type: "teleport" },
    { source: DASHBOARD_SOURCE, type: "ready" },
    { source: APP_SOURCE, type: "resize", height: Number.NaN },
    null,
  ])("parseOutboundMessage drops %j", (data) => {
    expect(parseOutboundMessage(data)).toBeNull();
  });

  it("listener ignores wrong origins, wrong sources, and unknown types", () => {
    const { listenTarget, fire } = fakeTargets();
    const onToken = vi.fn();
    const onTheme = vi.fn();
    const stop = listenToDashboard({ dashboardOrigin: ORIGIN, target: listenTarget, onToken, onTheme });
    fire("https://evil.example.com", { source: DASHBOARD_SOURCE, type: "token", token: "evil" });
    fire(ORIGIN, { source: APP_SOURCE, type: "ready" });
    fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "teleport" });
    fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "theme", mode: "dark" });
    expect(onToken).not.toHaveBeenCalled();
    expect(onTheme).toHaveBeenCalledTimes(1);
    expect(onTheme).toHaveBeenCalledWith({ mode: "dark" });
    stop();
  });
});

describe("inbound v1 dispatch", () => {
  it("routes every message type to its callback", () => {
    const { listenTarget, fire } = fakeTargets();
    const seen: AppInboundMessage[] = [];
    const stop = listenToDashboard({
      dashboardOrigin: ORIGIN,
      target: listenTarget,
      onToken: (token) => seen.push({ source: DASHBOARD_SOURCE, type: "token", token }),
      onResizeAck: () => seen.push({ source: DASHBOARD_SOURCE, type: "resize-ack" }),
      onTheme: (theme) => seen.push({ source: DASHBOARD_SOURCE, type: "theme", ...theme }),
      onTitleAction: (id) => seen.push({ source: DASHBOARD_SOURCE, type: "title-action", id }),
      onSaveBarAction: (action) => seen.push({ source: DASHBOARD_SOURCE, type: "save-bar-action", action }),
      onNavigate: (path) => seen.push({ source: DASHBOARD_SOURCE, type: "navigate", path }),
      onResourcePicked: (items) => seen.push({ source: DASHBOARD_SOURCE, type: "resource-picked", items }),
      onResourcePickCancelled: () => seen.push({ source: DASHBOARD_SOURCE, type: "resource-pick-cancelled" }),
    });
    fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "token", token: "live" });
    fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "resize-ack" });
    fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "theme", mode: "dark", locale: "en" });
    fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "title-action", id: "save" });
    fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "save-bar-action", action: "discard" });
    fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "navigate", path: "/orders/1" });
    fire(ORIGIN, {
      source: DASHBOARD_SOURCE,
      type: "resource-picked",
      items: [{ p_id: "p_1", title: "Shirt", image: "https://cdn.example.com/1.png" }],
    });
    fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "resource-pick-cancelled" });
    expect(seen).toEqual([
      { source: DASHBOARD_SOURCE, type: "token", token: "live" },
      { source: DASHBOARD_SOURCE, type: "resize-ack" },
      { source: DASHBOARD_SOURCE, type: "theme", mode: "dark", locale: "en" },
      { source: DASHBOARD_SOURCE, type: "title-action", id: "save" },
      { source: DASHBOARD_SOURCE, type: "save-bar-action", action: "discard" },
      { source: DASHBOARD_SOURCE, type: "navigate", path: "/orders/1" },
      {
        source: DASHBOARD_SOURCE,
        type: "resource-picked",
        items: [{ p_id: "p_1", title: "Shirt", image: "https://cdn.example.com/1.png" }],
      },
      { source: DASHBOARD_SOURCE, type: "resource-pick-cancelled" },
    ]);
    stop();
    fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "token", token: "late" });
    expect(seen).toHaveLength(8);
  });

  it("never truncates the opaque token", () => {
    const long = `tok_${"x".repeat(5000)}`;
    expect(parseInboundMessage({ source: DASHBOARD_SOURCE, type: "token", token: long })).toEqual({
      source: DASHBOARD_SOURCE,
      type: "token",
      token: long,
    });
  });
});

describe("outbound length caps", () => {
  it("truncates every capped string at post time", () => {
    const { postTarget, posts } = fakeTargets();
    sendToast(ORIGIN, postTarget, "m".repeat(600), { tone: "success", durationMs: 99_999 });
    sendTitle(ORIGIN, postTarget, "h".repeat(300), {
      primaryAction: { id: "i".repeat(100), label: "l".repeat(100), tone: "critical" },
      secondaryActions: [{ id: "s", label: "x" }],
    });
    sendNavigated(ORIGIN, postTarget, `/p/${"y".repeat(3000)}`);
    sendOpen(ORIGIN, postTarget, `https://merchant.example.com/${"z".repeat(3000)}`);
    expect(posts).toHaveLength(4);
    const toast = posts[0]?.message as { message: string; tone: string; durationMs: number };
    expect(toast.message).toHaveLength(500);
    expect(toast.tone).toBe("success");
    expect(toast.durationMs).toBe(10_000);
    const title = posts[1]?.message as {
      heading: string;
      primaryAction: { id: string; label: string; tone: string };
    };
    expect(title.heading).toHaveLength(200);
    expect(title.primaryAction.id).toHaveLength(64);
    expect(title.primaryAction.label).toHaveLength(80);
    const navigated = posts[2]?.message as { path: string };
    expect(navigated.path.length).toBeLessThanOrEqual(2048);
    const open = posts[3]?.message as { target: string };
    expect(open.target.length).toBeLessThanOrEqual(2048);
  });

  it("caps capabilities, selectionIds, and secondary actions", () => {
    const { postTarget, posts } = fakeTargets();
    sendReady(ORIGIN, postTarget, { capabilities: Array.from({ length: 40 }, (_, i) => `c${i}`) });
    sendPickResource(ORIGIN, postTarget, {
      resourceType: "product",
      multiple: true,
      filter: "digital",
      selectionIds: Array.from({ length: 120 }, (_, i) => `p_${i}`),
    });
    sendTitle(ORIGIN, postTarget, "h", {
      secondaryActions: Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, label: `A${i}` })),
    });
    const ready = posts[0]?.message as { capabilities: string[] };
    expect(ready.capabilities).toHaveLength(32);
    const pick = posts[1]?.message as { selectionIds: string[]; multiple: boolean; filter: string };
    expect(pick.selectionIds).toHaveLength(100);
    expect(pick.multiple).toBe(true);
    expect(pick.filter).toBe("digital");
    const title = posts[2]?.message as { secondaryActions: unknown[] };
    expect(title.secondaryActions).toHaveLength(5);
  });

  it("drops invalid sends without posting", () => {
    const { postTarget, posts } = fakeTargets();
    sendResize(ORIGIN, postTarget, Number.NaN);
    sendSaveBar(ORIGIN, postTarget, "maybe" as "dirty");
    sendNavigated(ORIGIN, postTarget, "");
    sendOpen(ORIGIN, postTarget, "");
    sendPickResource(ORIGIN, postTarget, { resourceType: "order" as "product" });
    sendToast(ORIGIN, postTarget, "ok", { tone: "loud" as "info" });
    expect(posts).toHaveLength(1);
  });

  it("clamps resize height and save-bar states post", () => {
    const { postTarget, posts } = fakeTargets();
    sendResize(ORIGIN, postTarget, 2000.6);
    sendSaveBar(ORIGIN, postTarget, "dirty");
    expect(posts[0]?.message).toEqual({ source: APP_SOURCE, type: "resize", height: 2001 });
    expect(posts[1]?.message).toEqual({ source: APP_SOURCE, type: "save-bar", state: "dirty" });
  });
});
