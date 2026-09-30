import { describe, expect, it, vi } from "vitest";
import { DASHBOARD_SOURCE } from "../src/frame.js";
import {
  applyTheme,
  getThemeModeFromUrl,
  installThemeListener,
  type ThemeDocument,
  themeBootstrapScript,
} from "../src/theme.js";

/** Theme follows the dashboard: URL first paint, bridge messages live. */

const ORIGIN = "https://merchant.example.com";

function fakeDocument(): ThemeDocument & { hasDarkClass: () => boolean } {
  const classes = new Set<string>();
  const style: { colorScheme: string } = { colorScheme: "light" };
  return {
    hasDarkClass: () => classes.has("dark"),
    documentElement: {
      classList: {
        toggle: (name: string, force?: boolean) => {
          const on = force ?? !classes.has(name);
          if (on) {
            classes.add(name);
          } else {
            classes.delete(name);
          }
        },
      },
      style,
    },
  };
}

describe("getThemeModeFromUrl", () => {
  it("reads theme=dark, defaults to light", () => {
    expect(getThemeModeFromUrl("https://app.example.test/admin?theme=dark")).toBe("dark");
    expect(getThemeModeFromUrl("https://app.example.test/admin?theme=light")).toBe("light");
    expect(getThemeModeFromUrl("https://app.example.test/admin")).toBe("light");
    expect(getThemeModeFromUrl("https://app.example.test/admin?theme=sepia")).toBe("light");
    expect(getThemeModeFromUrl("not a url at all")).toBe("light");
  });
});

describe("applyTheme", () => {
  it("toggles .dark on <html> + color-scheme", () => {
    const doc = fakeDocument();
    applyTheme("dark", doc);
    expect(doc.hasDarkClass()).toBe(true);
    expect(doc.documentElement.style.colorScheme).toBe("dark");
    applyTheme("light", doc);
    expect(doc.hasDarkClass()).toBe(false);
    expect(doc.documentElement.style.colorScheme).toBe("light");
  });

  it("is SSR-safe without a document", () => {
    expect(() => applyTheme("dark", undefined)).not.toThrow();
  });
});

describe("themeBootstrapScript", () => {
  it("paints dark before first paint from the URL param (no flash)", () => {
    const script = themeBootstrapScript();
    expect(script).toContain("location.search");
    expect(script).toContain("colorScheme");
    const run = new Function("document", "location", "URLSearchParams", script) as (
      document: ThemeDocument,
      location: { search: string },
      params: typeof URLSearchParams,
    ) => void;

    const darkDoc = fakeDocument();
    run(darkDoc, { search: "?theme=dark" }, URLSearchParams);
    expect(darkDoc.documentElement.style.colorScheme).toBe("dark");
    expect(darkDoc.hasDarkClass()).toBe(true);

    const lightDoc = fakeDocument();
    run(lightDoc, { search: "?theme=light&shop=x" }, URLSearchParams);
    expect(lightDoc.documentElement.style.colorScheme).toBe("light");
    expect(lightDoc.hasDarkClass()).toBe(false);

    const missingDoc = fakeDocument();
    run(missingDoc, { search: "" }, URLSearchParams);
    expect(missingDoc.documentElement.style.colorScheme).toBe("light");
  });
});

describe("installThemeListener", () => {
  it("applies bridge theme messages live and notifies", () => {
    const listeners = new Map<string, Set<(event: { origin: string; data: unknown }) => void>>();
    const target = {
      addEventListener: (type: string, listener: (event: { origin: string; data: unknown }) => void) => {
        const existing = listeners.get(type) ?? new Set<(event: { origin: string; data: unknown }) => void>();
        existing.add(listener);
        listeners.set(type, existing);
      },
      removeEventListener: (type: string, listener: (event: { origin: string; data: unknown }) => void) => {
        listeners.get(type)?.delete(listener);
      },
    };
    const doc = fakeDocument();
    const onChange = vi.fn();
    const stop = installThemeListener({ dashboardOrigin: ORIGIN, target, onChange, doc });
    const fire = (data: unknown) => {
      for (const listener of listeners.get("message") ?? []) {
        listener({ origin: ORIGIN, data });
      }
    };
    fire({ source: DASHBOARD_SOURCE, type: "theme", mode: "dark" });
    expect(doc.documentElement.style.colorScheme).toBe("dark");
    expect(onChange).toHaveBeenCalledWith("dark");
    fire({ source: DASHBOARD_SOURCE, type: "bogus" });
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
    fire({ source: DASHBOARD_SOURCE, type: "theme", mode: "light" });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
