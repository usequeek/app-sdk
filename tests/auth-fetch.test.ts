import { describe, expect, it, vi } from "vitest";
import { installAuthFetch, readLaunchToken, stripLaunchToken } from "../src/auth-fetch.js";
import { DASHBOARD_SOURCE } from "../src/frame.js";

const ORIGIN = "https://merchant.example.com";
const APP_URL = "https://app.example.test/admin?shop=demo&id_token=launch-abc&theme=dark";

interface FireTarget {
  addEventListener(type: string, listener: (event: { origin: string; data: unknown }) => void): void;
  removeEventListener(type: string, listener: (event: { origin: string; data: unknown }) => void): void;
  fire(origin: string, data: unknown): void;
}

function fakeListenTarget(): FireTarget {
  let listener: ((event: { origin: string; data: unknown }) => void) | null = null;
  return {
    addEventListener: (_type, next) => {
      listener = next;
    },
    removeEventListener: (_type, next) => {
      if (listener === next) {
        listener = null;
      }
    },
    fire: (origin, data) => {
      listener?.({ origin, data });
    },
  };
}

function fakePosts() {
  const posts: { message: unknown; origin: string }[] = [];
  return {
    posts,
    postTarget: {
      postMessage: (message: unknown, origin: string) => {
        posts.push({ message, origin });
      },
    },
  };
}

function jsonResponse(status: number, body = ""): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

describe("readLaunchToken / stripLaunchToken", () => {
  it("reads id_token and strips only that param", () => {
    expect(readLaunchToken(APP_URL)).toBe("launch-abc");
    expect(readLaunchToken("https://app.example.test/admin?shop=demo")).toBeNull();
    const stripped = stripLaunchToken(APP_URL);
    expect(stripped).not.toBeNull();
    expect(stripped).not.toContain("id_token");
    expect(stripped).toContain("shop=demo");
    expect(stripped).toContain("theme=dark");
    expect(stripLaunchToken("https://app.example.test/admin?shop=demo")).toBeNull();
  });
});

describe("installAuthFetch", () => {
  it("strips the token from the URL, exchanges once, attaches Bearer [REDACTED] same-origin", async () => {
    const listenTarget = fakeListenTarget();
    const { postTarget } = fakePosts();
    const replaced: string[] = [];
    const exchange = vi.fn(async (token: string) => `sess-for-${token}`);
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse(200, "{}");
    });

    const auth = installAuthFetch({
      exchange,
      dashboardOrigin: ORIGIN,
      postTarget,
      listenTarget,
      fetchImpl,
      getHref: () => APP_URL,
      replaceUrl: (url) => {
        replaced.push(url);
      },
    });

    expect(replaced).toHaveLength(1);
    expect(replaced[0]).not.toContain("id_token");
    expect(await auth.ready).toBe("sess-for-launch-abc");
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(exchange).toHaveBeenCalledWith("launch-abc");

    await auth.fetch("/admin/api/orders");
    await auth.fetch("https://app.example.test/admin/api/more");
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get("authorization")).toBe("Bearer sess-for-launch-abc");
      expect(call.init?.credentials).toBe("omit");
    }
    expect(exchange).toHaveBeenCalledTimes(1);
    auth.dispose();
  });

  it("passes cross-origin requests through untouched", async () => {
    const listenTarget = fakeListenTarget();
    const { postTarget } = fakePosts();
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const auth = installAuthFetch({
      exchange: async () => "sess",
      dashboardOrigin: ORIGIN,
      postTarget,
      listenTarget,
      fetchImpl: async (url: string, init?: RequestInit) => {
        seen.push({ url, init });
        return jsonResponse(200);
      },
      getHref: () => APP_URL,
      replaceUrl: () => {},
    });
    await auth.ready;
    await auth.fetch("https://cdn.example.com/lib.js");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.init?.headers).toBeUndefined();
    expect(seen[0]?.init?.credentials).toBeUndefined();
    auth.dispose();
  });

  it("keeps a caller-supplied Authorization header", async () => {
    const listenTarget = fakeListenTarget();
    const { postTarget } = fakePosts();
    let sent: Headers | null = null;
    const auth = installAuthFetch({
      exchange: async () => "sess-new",
      dashboardOrigin: ORIGIN,
      postTarget,
      listenTarget,
      fetchImpl: async (_url: string, init?: RequestInit) => {
        sent = new Headers(init?.headers);
        return jsonResponse(200);
      },
      getHref: () => APP_URL,
      replaceUrl: () => {},
    });
    await auth.ready;
    await auth.fetch("/admin/api/x", { headers: { authorization: "Bearer custom" } });
    expect(sent?.get("authorization")).toBe("Bearer custom");
    auth.dispose();
  });

  it("re-establishes on 401 via ready→token and retries once", async () => {
    const listenTarget = fakeListenTarget();
    const { posts, postTarget } = fakePosts();
    const exchange = vi.fn(async (token: string) => `sess-for-${token}`);
    const attempts: (string | null)[] = [];
    const auth = installAuthFetch({
      exchange,
      dashboardOrigin: ORIGIN,
      postTarget,
      listenTarget,
      fetchImpl: async (_url: string, init?: RequestInit) => {
        const header = new Headers(init?.headers).get("authorization");
        attempts.push(header);
        return header === "Bearer sess-for-fresh" ? jsonResponse(200, "{}") : jsonResponse(401);
      },
      getHref: () => APP_URL,
      replaceUrl: () => {},
    });
    await auth.ready;

    const pending = auth.fetch("/admin/api/orders");
    // The 401 triggers a ready post; answer it with a fresh bridge token.
    await vi.waitFor(() => {
      expect(posts.at(-1)?.message).toEqual({ source: "queek-app", type: "ready" });
    });
    listenTarget.fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "token", token: "fresh" });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(exchange).toHaveBeenCalledTimes(2);
    expect(exchange).toHaveBeenLastCalledWith("fresh");
    expect(attempts).toEqual(["Bearer sess-for-launch-abc", "Bearer sess-for-fresh"]);
    expect(auth.getSession()).toBe("sess-for-fresh");
    auth.dispose();
  });

  it("returns the 401 when the refresh fails", async () => {
    const listenTarget = fakeListenTarget();
    const { posts, postTarget } = fakePosts();
    const auth = installAuthFetch({
      exchange: async () => "sess",
      dashboardOrigin: ORIGIN,
      postTarget,
      listenTarget,
      fetchImpl: async () => jsonResponse(401),
      getHref: () => APP_URL,
      replaceUrl: () => {},
    });
    await auth.ready;
    const pending = auth.fetch("/admin/api/orders");
    // Wait until the 401 has triggered the refresh (ready posted)…
    await vi.waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    // …then prove a wrong-origin token reply does not satisfy the wait.
    listenTarget.fire("https://evil.example.com", {
      source: DASHBOARD_SOURCE,
      type: "token",
      token: "evil",
    });
    // Disposing mid-refresh fails the wait at once (no 8 s timeout in tests).
    auth.dispose();
    const res = await pending;
    expect(res.status).toBe(401);
  });

  it("works without a launch token and fetches without a header", async () => {
    const listenTarget = fakeListenTarget();
    const { postTarget } = fakePosts();
    const exchange = vi.fn(async () => "sess");
    let sent: Headers | null = null;
    const auth = installAuthFetch({
      exchange,
      dashboardOrigin: ORIGIN,
      postTarget,
      listenTarget,
      fetchImpl: async (_url: string, init?: RequestInit) => {
        sent = new Headers(init?.headers);
        return jsonResponse(200);
      },
      getHref: () => "https://app.example.test/admin?shop=demo",
      replaceUrl: () => {
        throw new Error("must not strip without a token");
      },
    });
    expect(await auth.ready).toBeNull();
    expect(exchange).not.toHaveBeenCalled();
    await auth.fetch("/admin/api/orders");
    expect(sent?.has("authorization")).toBe(false);
    auth.dispose();
  });
});
