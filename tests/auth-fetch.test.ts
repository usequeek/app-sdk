import { describe, expect, it, vi } from "vitest";
import { installAuthFetch, readLaunchToken, stripLaunchToken } from "../src/auth-fetch.js";
import { DASHBOARD_SOURCE } from "../src/frame.js";

const ORIGIN = "https://merchant.example.com";
const APP_URL = "https://app.example.test/admin?shop=demo&id_token=launch-abc&theme=dark";

interface FireTarget {
  addEventListener(
    type: string,
    listener: (event: { origin: string; data: unknown; source?: unknown }) => void,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: { origin: string; data: unknown; source?: unknown }) => void,
  ): void;
  fire(origin: string, data: unknown, source?: unknown): void;
}

function fakeListenTarget(): FireTarget {
  let listener: ((event: { origin: string; data: unknown; source?: unknown }) => void) | null = null;
  return {
    addEventListener: (_type, next) => {
      listener = next;
    },
    removeEventListener: (_type, next) => {
      if (listener === next) {
        listener = null;
      }
    },
    fire: (origin, data, source) => {
      listener?.({ origin, data, source });
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

  it("recovers a null session via the bridge ready→token flow", async () => {
    const listenTarget = fakeListenTarget();
    const { posts, postTarget } = fakePosts();
    const exchange = vi.fn(async (token: string) => `sess-for-${token}`);
    let sent: Headers | null = null;
    const auth = installAuthFetch({
      exchange,
      dashboardOrigin: ORIGIN,
      postTarget,
      listenTarget,
      fetchImpl: async (_url: string, init?: RequestInit) => {
        sent = new Headers(init?.headers);
        return jsonResponse(200, "{}");
      },
      getHref: () => "https://app.example.test/admin?shop=demo",
      replaceUrl: () => {
        throw new Error("must not strip without a token");
      },
    });
    expect(await auth.ready).toBeNull();
    expect(exchange).not.toHaveBeenCalled();

    const pending = auth.fetch("/admin/api/orders");
    await vi.waitFor(() => {
      expect(posts.at(-1)?.message).toEqual({ source: "queek-app", type: "ready" });
    });
    listenTarget.fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "token", token: "late" });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(exchange).toHaveBeenCalledWith("late");
    expect(sent?.get("authorization")).toBe("Bearer sess-for-late");
    auth.dispose();
  });

  it("fetches without a header when the recovery fails", async () => {
    const listenTarget = fakeListenTarget();
    const { posts, postTarget } = fakePosts();
    let sent: Headers | null = null;
    const auth = installAuthFetch({
      exchange: async () => "sess",
      dashboardOrigin: ORIGIN,
      postTarget,
      listenTarget,
      fetchImpl: async (_url: string, init?: RequestInit) => {
        sent = new Headers(init?.headers);
        return jsonResponse(200);
      },
      getHref: () => "https://app.example.test/admin?shop=demo",
      replaceUrl: () => {},
    });
    const pending = auth.fetch("/admin/api/orders");
    await vi.waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    auth.dispose();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(sent?.has("authorization")).toBe(false);
  });

  it("only honors the token reply from the expected source", async () => {
    const listenTarget = fakeListenTarget();
    const { postTarget } = fakePosts();
    const parent = { name: "parent" };
    const exchange = vi.fn(async (token: string) => `sess-for-${token}`);
    const auth = installAuthFetch({
      exchange,
      dashboardOrigin: ORIGIN,
      postTarget,
      listenTarget,
      expectSource: parent,
      fetchImpl: async () => jsonResponse(200),
      getHref: () => "https://app.example.test/admin?shop=demo",
      replaceUrl: () => {},
    });
    const pending = auth.refresh();
    listenTarget.fire(
      ORIGIN,
      { source: DASHBOARD_SOURCE, type: "token", token: "evil" },
      { name: "stranger" },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exchange).not.toHaveBeenCalled();
    listenTarget.fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "token", token: "real" }, parent);
    await expect(pending).resolves.toBe("sess-for-real");
    auth.dispose();
  });
});

describe("request URL resolution", () => {
  function setup(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
    const listenTarget = fakeListenTarget();
    const { postTarget } = fakePosts();
    const seen: { url: unknown; init: RequestInit | undefined }[] = [];
    const auth = installAuthFetch({
      exchange: async () => "sess",
      dashboardOrigin: ORIGIN,
      postTarget,
      listenTarget,
      fetchImpl: async (url: string, init?: RequestInit) => {
        seen.push({ url, init });
        return fetchImpl(url, init);
      },
      getHref: () => APP_URL,
      replaceUrl: () => {},
    });
    return { auth, seen };
  }

  it("never sends the bearer for a cross-origin Request object", async () => {
    const { auth, seen } = setup(async () => jsonResponse(200));
    await auth.ready;
    await auth.fetch(new Request("https://evil.example/steal"));
    expect(seen).toHaveLength(1);
    expect(new Headers(seen[0]?.init?.headers).has("authorization")).toBe(false);
    expect(seen[0]?.init?.credentials).toBeUndefined();
    auth.dispose();
  });

  it("sends the bearer for a same-origin Request and merges its headers", async () => {
    const { auth, seen } = setup(async () => jsonResponse(200));
    await auth.ready;
    await auth.fetch(new Request("https://app.example.test/admin/api/x", { headers: { "x-trace": "1" } }));
    expect(seen).toHaveLength(1);
    const headers = new Headers(seen[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sess");
    expect(headers.get("x-trace")).toBe("1");
    auth.dispose();
  });

  it("resolves URL objects and protocol-relative URLs by origin", async () => {
    const { auth, seen } = setup(async () => jsonResponse(200));
    await auth.ready;
    await auth.fetch(new URL("https://app.example.test/admin/api/a"));
    await auth.fetch("//app.example.test/admin/api/b");
    await auth.fetch("//evil.example/admin/api/c");
    await auth.fetch("https://evil.example/admin/api/d");
    const authHeaders = seen.map((call) => new Headers(call.init?.headers).get("authorization"));
    expect(authHeaders).toEqual(["Bearer sess", "Bearer sess", null, null]);
    auth.dispose();
  });

  it("passes non-URL inputs through without a bearer", async () => {
    const { auth, seen } = setup(async () => jsonResponse(200));
    await auth.ready;
    await auth.fetch(42 as unknown as string);
    expect(seen).toHaveLength(1);
    expect(new Headers(seen[0]?.init?.headers).has("authorization")).toBe(false);
    auth.dispose();
  });
});

describe("shared refresh", () => {
  it("parallel requests share ONE exchange and ONE refresh", async () => {
    const listenTarget = fakeListenTarget();
    const { posts, postTarget } = fakePosts();
    const exchange = vi.fn(async (token: string) => `sess-for-${token}`);
    const headers: (string | null)[] = [];
    const auth = installAuthFetch({
      exchange,
      dashboardOrigin: ORIGIN,
      postTarget,
      listenTarget,
      fetchImpl: async (_url: string, init?: RequestInit) => {
        headers.push(new Headers(init?.headers).get("authorization"));
        return jsonResponse(200);
      },
      getHref: () => "https://app.example.test/admin?shop=demo",
      replaceUrl: () => {},
    });
    const [first, second] = await Promise.all([
      (async () => {
        const pending = auth.fetch("/a");
        await vi.waitFor(() => {
          expect(posts).toHaveLength(1);
        });
        listenTarget.fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "token", token: "shared" });
        return pending;
      })(),
      auth.fetch("/b"),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(1);
    expect(headers).toEqual(["Bearer sess-for-shared", "Bearer sess-for-shared"]);
    auth.dispose();
  });

  it("a 401 after a completed refresh retries with the session, not a new refresh", async () => {
    const listenTarget = fakeListenTarget();
    const { posts, postTarget } = fakePosts();
    const exchange = vi.fn(async (token: string) => `sess-for-${token}`);
    let launchCalls = 0;
    const auth = installAuthFetch({
      exchange,
      dashboardOrigin: ORIGIN,
      postTarget,
      listenTarget,
      fetchImpl: async (_url: string, init?: RequestInit) => {
        const header = new Headers(init?.headers).get("authorization");
        if (header === "Bearer sess-for-launch-abc") {
          launchCalls += 1;
          // The second in-flight call answers late — after the refresh below.
          await new Promise((resolve) => setTimeout(resolve, launchCalls === 1 ? 0 : 60));
          return jsonResponse(401);
        }
        return jsonResponse(200);
      },
      getHref: () => APP_URL,
      replaceUrl: () => {},
    });
    await auth.ready;
    const first = auth.fetch("/a");
    const second = auth.fetch("/b");
    await vi.waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    listenTarget.fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "token", token: "fresh" });
    const [resA, resB] = await Promise.all([first, second]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(posts).toHaveLength(1);
    expect(exchange).toHaveBeenCalledTimes(2);
    auth.dispose();
  });
});
