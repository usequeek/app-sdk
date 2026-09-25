import { describe, expect, it } from "vitest";
import { runInstallationCatchup } from "../src/background.js";
import { QueekApiError } from "../src/client.js";
import { SqliteInstallationStore } from "../src/store.js";

const STORE_KEY = Buffer.alloc(32, 45).toString("base64");

function installations(ids: string[]) {
  return ids.map((id) => ({ installationId: id, installationPid: `pid_${id}` }));
}

describe("runInstallationCatchup", () => {
  it("sleeps one uniform start jitter (0–max), then visits every installation", async () => {
    const sleeps: number[] = [];
    const visited: string[] = [];
    const result = await runInstallationCatchup({
      installations: installations(["a", "b"]),
      maxStartJitterMs: 600_000,
      random: () => 0.5,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      forInstallation: async (installation) => {
        visited.push(installation.installationId);
      },
    });
    expect(sleeps).toEqual([300_000]);
    expect(visited.sort()).toEqual(["a", "b"]);
    expect(result).toEqual({ ok: ["a", "b"], failed: [] });
  });

  it("isolates per-installation failures (one throws, the rest still run)", async () => {
    const seen: Array<{ installationId: string }> = [];
    const result = await runInstallationCatchup({
      installations: installations(["a", "b", "c"]),
      maxStartJitterMs: 0,
      concurrency: 1,
      sleep: async () => undefined,
      onError: (failure) => {
        seen.push({ installationId: failure.installationId });
      },
      forInstallation: async (installation) => {
        if (installation.installationId === "b") throw new Error("boom");
      },
    });
    expect(result.ok).toEqual(["a", "c"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.installationId).toBe("b");
    expect(seen).toEqual([{ installationId: "b" }]);
  });

  it("caps in-flight installations at the concurrency (default 2, pool-sized)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const gate = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
    await runInstallationCatchup({
      installations: installations(["a", "b", "c", "d", "e"]),
      maxStartJitterMs: 0,
      sleep: async () => undefined,
      forInstallation: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate();
        inFlight -= 1;
      },
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBe(2);
  });

  it("honors a 429 once per installation (sleep, retry), then records a repeat as failed", async () => {
    const sleeps: number[] = [];
    const attempts = new Map<string, number>();
    const result = await runInstallationCatchup({
      installations: installations(["flaky", "doomed"]),
      maxStartJitterMs: 0,
      concurrency: 1,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      forInstallation: async (installation) => {
        const count = (attempts.get(installation.installationId) ?? 0) + 1;
        attempts.set(installation.installationId, count);
        if (installation.installationId === "flaky" && count === 1) {
          throw new QueekApiError({
            status: 429,
            code: "too_many_requests",
            message: "Slow.",
            retryAfterMs: 1500,
          });
        }
        if (installation.installationId === "doomed") {
          throw new QueekApiError({
            status: 429,
            code: "too_many_requests",
            message: "Slow.",
            retryAfterMs: 1500,
          });
        }
      },
    });
    expect(result.ok).toEqual(["flaky"]);
    expect(result.failed.map((failure) => failure.installationId)).toEqual(["doomed"]);
    expect(sleeps).toEqual([1500, 1500]);
    expect(attempts.get("flaky")).toBe(2);
    expect(attempts.get("doomed")).toBe(2);
  });

  it("iterates the store when no explicit list is given", async () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    const now = new Date().toISOString();
    for (const id of ["a", "b"]) {
      store.saveInstallation({
        installationId: id,
        installationPid: `pid_${id}`,
        vendorId: "v",
        storePid: null,
        storeName: "S",
        apiBase: "https://api.usequeek.com",
        token: null,
        tokenExpiresAt: null,
        tokenKid: null,
        scopes: [],
        settings: {},
        webhookSecret: null,
        webhookUrl: null,
        webhookTopics: [],
        installedAt: now,
        updatedAt: now,
      });
    }
    const visited: string[] = [];
    const result = await runInstallationCatchup({
      store,
      maxStartJitterMs: 0,
      sleep: async () => undefined,
      forInstallation: async (installation) => {
        visited.push(installation.installationId);
      },
    });
    expect(visited.sort()).toEqual(["a", "b"]);
    expect(result.failed).toEqual([]);
    store.close();
  });
});
