// @vitest-environment jsdom
import { act, Component, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DASHBOARD_SOURCE } from "../src/frame.js";
import { PICK_TIMEOUT_MS, type QueekApi, QueekProvider, useQueek } from "../src/react.js";

/** ./react: useQueek() posts the right bridge messages over the core. */

const ORIGIN = "https://merchant.example.com";

interface Posted {
  message: unknown;
  origin: string;
}

function fakeBridge() {
  const posts: Posted[] = [];
  let listener: ((event: { origin: string; data: unknown }) => void) | null = null;
  const listenTarget = {
    addEventListener: (_type: string, next: (event: { origin: string; data: unknown }) => void) => {
      listener = next;
    },
    removeEventListener: (_type: string, next: (event: { origin: string; data: unknown }) => void) => {
      if (listener === next) {
        listener = null;
      }
    },
  };
  const postTarget = {
    postMessage: (message: unknown, origin: string) => {
      posts.push({ message, origin });
    },
  };
  const fire = (origin: string, data: unknown, source: unknown = window.parent) => {
    listener?.({ origin, data, source });
  };
  return { posts, listenTarget, postTarget, fire };
}

function probe(onApi: (api: QueekApi) => void): () => ReactNode {
  return () => {
    onApi(useQueek());
    return null;
  };
}

describe("useQueek", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root !== null) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(node: ReactNode): Promise<void> {
    await act(async () => {
      root?.render(node);
    });
  }

  it("announces ready with capabilities and posts each action's message", async () => {
    const bridge = fakeBridge();
    let api: QueekApi | null = null;
    await render(
      createElement(
        QueekProvider,
        {
          dashboardOrigin: ORIGIN,
          capabilities: ["title", "toast"],
          sdkVersion: "0.5.1",
          postTarget: bridge.postTarget,
          listenTarget: bridge.listenTarget,
          getHref: () => "https://app.example.test/admin?theme=light",
        },
        createElement(
          probe((next) => {
            api = next;
          }),
        ),
      ),
    );
    expect(api).not.toBeNull();
    expect(bridge.posts[0]).toEqual({
      message: {
        source: "queek-app",
        type: "ready",
        capabilities: ["title", "toast"],
        sdkVersion: "0.5.1",
      },
      origin: ORIGIN,
    });
    expect(api?.theme.mode).toBe("light");

    await act(async () => {
      api?.toast("Saved", { tone: "success" });
      api?.saveBar.dirty();
      api?.title.set("Orders", { primaryAction: { id: "new", label: "New order" } });
      api?.navigate.report("/orders/1");
      api?.navigate.open("/products/new");
    });
    const types = bridge.posts.slice(1).map((post) => (post.message as { type: string }).type);
    expect(types).toEqual(["toast", "save-bar", "title", "navigated", "open"]);
    expect(bridge.posts[1]?.message).toMatchObject({ type: "toast", message: "Saved", tone: "success" });
    expect(bridge.posts[2]?.message).toMatchObject({ type: "save-bar", state: "dirty" });
    expect(bridge.posts[3]?.message).toMatchObject({ type: "title", heading: "Orders" });
    expect(bridge.posts[4]?.message).toMatchObject({ type: "navigated", path: "/orders/1" });
    expect(bridge.posts[5]?.message).toMatchObject({ type: "open", target: "/products/new" });
    for (const post of bridge.posts) {
      expect(post.origin).toBe(ORIGIN);
    }
  });

  it("dispatches title/save-bar/navigate actions to subscribers", async () => {
    const bridge = fakeBridge();
    let api: QueekApi | null = null;
    await render(
      createElement(
        QueekProvider,
        {
          dashboardOrigin: ORIGIN,
          postTarget: bridge.postTarget,
          listenTarget: bridge.listenTarget,
          getHref: () => "https://app.example.test/admin",
        },
        createElement(
          probe((next) => {
            api = next;
          }),
        ),
      ),
    );
    const titleActions: string[] = [];
    const saveActions: string[] = [];
    const paths: string[] = [];
    api?.title.onAction((id) => titleActions.push(id));
    api?.saveBar.onAction((action) => saveActions.push(action));
    api?.navigate.onNavigate((path) => paths.push(path));
    await act(async () => {
      bridge.fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "title-action", id: "new" });
      bridge.fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "save-bar-action", action: "save" });
      bridge.fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "navigate", path: "/orders/2" });
    });
    expect(titleActions).toEqual(["new"]);
    expect(saveActions).toEqual(["save"]);
    expect(paths).toEqual(["/orders/2"]);
  });

  it("resolves pickResource on picked, null on cancelled, one at a time", async () => {
    const bridge = fakeBridge();
    let api: QueekApi | null = null;
    await render(
      createElement(
        QueekProvider,
        {
          dashboardOrigin: ORIGIN,
          postTarget: bridge.postTarget,
          listenTarget: bridge.listenTarget,
          getHref: () => "https://app.example.test/admin",
        },
        createElement(
          probe((next) => {
            api = next;
          }),
        ),
      ),
    );
    const first = api?.pickResource({ resourceType: "product", multiple: true });
    await expect(api?.pickResource({ resourceType: "product" })).rejects.toThrow(/already in progress/);
    expect(bridge.posts.at(-1)?.message).toMatchObject({ type: "pick-resource", resourceType: "product" });
    await act(async () => {
      bridge.fire(ORIGIN, {
        source: DASHBOARD_SOURCE,
        type: "resource-picked",
        items: [{ p_id: "p_1", title: "Shirt" }],
      });
    });
    await expect(first).resolves.toEqual([{ p_id: "p_1", title: "Shirt" }]);

    const second = api?.pickResource({ resourceType: "product" });
    await act(async () => {
      bridge.fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "resource-pick-cancelled" });
    });
    await expect(second).resolves.toBeNull();
  });

  it("follows live theme messages", async () => {
    const bridge = fakeBridge();
    let api: QueekApi | null = null;
    await render(
      createElement(
        QueekProvider,
        {
          dashboardOrigin: ORIGIN,
          postTarget: bridge.postTarget,
          listenTarget: bridge.listenTarget,
          getHref: () => "https://app.example.test/admin?theme=light",
        },
        createElement(
          probe((next) => {
            api = next;
          }),
        ),
      ),
    );
    expect(api?.theme.mode).toBe("light");
    await act(async () => {
      bridge.fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "theme", mode: "dark" });
    });
    expect(api?.theme.mode).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await act(async () => {
      bridge.fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "theme", mode: "light" });
    });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("syncs the URL theme after mount (SSR-safe first render)", async () => {
    const bridge = fakeBridge();
    let api: QueekApi | null = null;
    await render(
      createElement(
        QueekProvider,
        {
          dashboardOrigin: ORIGIN,
          postTarget: bridge.postTarget,
          listenTarget: bridge.listenTarget,
          getHref: () => "https://app.example.test/admin?theme=dark",
        },
        createElement(
          probe((next) => {
            api = next;
          }),
        ),
      ),
    );
    expect(api?.theme.mode).toBe("dark");
  });

  it("ignores bridge messages from the wrong sender window", async () => {
    const bridge = fakeBridge();
    let api: QueekApi | null = null;
    await render(
      createElement(
        QueekProvider,
        {
          dashboardOrigin: ORIGIN,
          postTarget: bridge.postTarget,
          listenTarget: bridge.listenTarget,
          getHref: () => "https://app.example.test/admin",
        },
        createElement(
          probe((next) => {
            api = next;
          }),
        ),
      ),
    );
    await act(async () => {
      bridge.fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "theme", mode: "dark" }, { name: "stranger" });
    });
    expect(api?.theme.mode).toBe("light");
    await act(async () => {
      bridge.fire(ORIGIN, { source: DASHBOARD_SOURCE, type: "theme", mode: "dark" });
    });
    expect(api?.theme.mode).toBe("dark");
  });

  it("survives parent re-renders: one ready, in-flight pick intact", async () => {
    const bridge = fakeBridge();
    let api: QueekApi | null = null;
    const shell = (bump: number) =>
      createElement(
        QueekProvider,
        {
          dashboardOrigin: ORIGIN,
          // Fresh inline props every render — the bridge must NOT resubscribe.
          capabilities: ["title", "toast"],
          postTarget: bridge.postTarget,
          listenTarget: bridge.listenTarget,
          getHref: () => `https://app.example.test/admin?n=${bump}`,
        },
        createElement(
          probe((next) => {
            api = next;
          }),
        ),
      );
    await render(shell(0));
    const picking = api?.pickResource({ resourceType: "product" });
    await render(shell(1));
    await render(shell(2));
    expect(bridge.posts.filter((post) => (post.message as { type: string }).type === "ready")).toHaveLength(
      1,
    );
    await act(async () => {
      bridge.fire(ORIGIN, {
        source: DASHBOARD_SOURCE,
        type: "resource-picked",
        items: [{ p_id: "p_9", title: "Kept" }],
      });
    });
    await expect(picking).resolves.toEqual([{ p_id: "p_9", title: "Kept" }]);
  });

  it("rejects invalid picks before registering (no deadlock)", async () => {
    const bridge = fakeBridge();
    let api: QueekApi | null = null;
    await render(
      createElement(
        QueekProvider,
        {
          dashboardOrigin: ORIGIN,
          postTarget: bridge.postTarget,
          listenTarget: bridge.listenTarget,
          getHref: () => "https://app.example.test/admin",
        },
        createElement(
          probe((next) => {
            api = next;
          }),
        ),
      ),
    );
    const readyPosts = bridge.posts.length;
    await expect(api?.pickResource({ resourceType: "order" as "product" })).rejects.toThrow(
      /product resources only/,
    );
    expect(bridge.posts).toHaveLength(readyPosts);
    const valid = api?.pickResource({ resourceType: "product" });
    await act(async () => {
      bridge.fire(ORIGIN, {
        source: DASHBOARD_SOURCE,
        type: "resource-picked",
        items: [{ p_id: "p_1", title: "Shirt" }],
      });
    });
    await expect(valid).resolves.toEqual([{ p_id: "p_1", title: "Shirt" }]);
  });

  it("rejects at once when the dashboard lacks pick-resource", async () => {
    const bridge = fakeBridge();
    let api: QueekApi | null = null;
    await render(
      createElement(
        QueekProvider,
        {
          dashboardOrigin: ORIGIN,
          dashboardCapabilities: ["title", "toast"],
          postTarget: bridge.postTarget,
          listenTarget: bridge.listenTarget,
          getHref: () => "https://app.example.test/admin",
        },
        createElement(
          probe((next) => {
            api = next;
          }),
        ),
      ),
    );
    const readyPosts = bridge.posts.length;
    await expect(api?.pickResource({ resourceType: "product" })).rejects.toThrow(/does not support/);
    expect(bridge.posts).toHaveLength(readyPosts);
  });

  it("times out a pick the dashboard never answers", async () => {
    const bridge = fakeBridge();
    let api: QueekApi | null = null;
    await render(
      createElement(
        QueekProvider,
        {
          dashboardOrigin: ORIGIN,
          postTarget: bridge.postTarget,
          listenTarget: bridge.listenTarget,
          getHref: () => "https://app.example.test/admin",
        },
        createElement(
          probe((next) => {
            api = next;
          }),
        ),
      ),
    );
    vi.useFakeTimers();
    try {
      const picking = api?.pickResource({ resourceType: "product" });
      const assertion = expect(picking).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(PICK_TIMEOUT_MS);
      await assertion;
      // The slot is free again after the timeout.
      const retry = api?.pickResource({ resourceType: "product" });
      await act(async () => {
        bridge.fire(ORIGIN, {
          source: DASHBOARD_SOURCE,
          type: "resource-picked",
          items: [{ p_id: "p_2", title: "Again" }],
        });
      });
      await expect(retry).resolves.toEqual([{ p_id: "p_2", title: "Again" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws outside the provider", async () => {
    const errors: string[] = [];
    class Boundary extends Component<{ children?: ReactNode }> {
      componentDidCatch(error: unknown): void {
        errors.push(error instanceof Error ? error.message : String(error));
      }

      render(): ReactNode {
        return this.props.children ?? null;
      }
    }
    const Bad = (): ReactNode => {
      useQueek();
      return null;
    };
    await render(createElement(Boundary, null, createElement(Bad)));
    expect(errors).toEqual(["useQueek must be used inside <QueekProvider>"]);
  });
});
