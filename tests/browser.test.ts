import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as browser from "../src/browser.js";

/**
 * `./browser` is the ONE browser-safe subpath: importing it from a browser
 * bundle must never pull `node:*`, `pg`, `hono`, `jose`, or `react`. This
 * test statically walks `src/browser.ts`'s transitive relative imports and
 * fails on the first banned specifier, so a future edit can never silently
 * regress the entry (the Booking Vite failure).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "src");
const ENTRY = resolve(SRC, "browser.ts");

const BANNED_PACKAGES = new Set(["pg", "hono", "jose", "react", "react-dom"]);

function isBanned(specifier: string): boolean {
  if (specifier.startsWith("node:")) {
    return true;
  }
  const base = specifier.split("/")[0] ?? "";
  return BANNED_PACKAGES.has(base);
}

/** Module specifiers from static + dynamic imports, comments stripped. */
function specifiersOf(source: string): string[] {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const code = withoutBlocks
    .split("\n")
    .map((line) => {
      // Keep `https://…` URLs inside string literals: only a `//` that is
      // NOT preceded by `:` starts a line comment.
      const cut = line.search(/(?<!:)\/\//);
      return cut === -1 ? line : line.slice(0, cut);
    })
    .join("\n");
  const found: string[] = [];
  for (const re of [
    /(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g,
    /import\s*["']([^"']+)["']/g,
    /(?:import|require)\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of code.matchAll(re)) {
      const spec = match[1];
      if (spec !== undefined) {
        found.push(spec);
      }
    }
  }
  return found;
}

/** Every local file reachable from the entry via relative imports. */
function transitiveLocalFiles(entry: string): string[] {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    for (const spec of specifiersOf(readFileSync(file, "utf-8"))) {
      if (!spec.startsWith(".")) {
        continue;
      }
      const resolved = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      if (!resolved.startsWith(`${SRC}/`) || !existsSync(resolved)) {
        throw new Error(`browser entry reaches outside src or a missing file: ${spec} (from ${file})`);
      }
      if (!seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return [...seen].sort();
}

describe("browser entry", () => {
  it("exposes installAuthFetch and the bridge/theme helpers", () => {
    for (const name of [
      "installAuthFetch",
      "readLaunchToken",
      "stripLaunchToken",
      "sendReady",
      "listenToDashboard",
      "sendNavigated",
      "sendOpen",
      "sendTitle",
      "sendSaveBar",
      "sendPickResource",
      "applyTheme",
      "getThemeModeFromUrl",
      "rememberThemeMode",
      "syncThemeUrl",
      "installThemeListener",
      "themeBootstrapScript",
    ] as const) {
      expect(typeof (browser as Record<string, unknown>)[name], name).toBe("function");
    }
    expect(browser.LAUNCH_TOKEN_PARAM).toBe("queek_token");
    expect(browser.THEME_PARAM).toBe("theme");
  });

  it("reaches only modules with no node-only dependencies", () => {
    const violations: string[] = [];
    for (const file of transitiveLocalFiles(ENTRY)) {
      const short = file.slice(SRC.length + 1);
      for (const spec of specifiersOf(readFileSync(file, "utf-8"))) {
        if (!spec.startsWith(".") && isBanned(spec)) {
          violations.push(`${short} imports banned ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("stays a leaf set: auth-fetch, frame, theme only", () => {
    const files = transitiveLocalFiles(ENTRY).map((file) => file.slice(SRC.length + 1));
    expect(files).toEqual(["auth-fetch.ts", "browser.ts", "frame.ts", "theme.ts"]);
  });

  it("is wired in the package exports map", () => {
    const pkg = JSON.parse(readFileSync(resolve(HERE, "..", "package.json"), "utf-8")) as {
      exports?: Record<string, { types?: string; default?: string }>;
    };
    expect(pkg.exports?.["./browser"]).toEqual({
      types: "./dist/browser.d.ts",
      default: "./dist/browser.js",
    });
  });
});
