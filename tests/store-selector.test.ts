import { afterEach, describe, expect, it } from "vitest";
import {
  createInstallationStore,
  createPostgresPool,
  normaliseNullablePid,
  normalisePid,
  PostgresInstallationStore,
  SqliteInstallationStore,
} from "../src/store.js";

const STORE_KEY = Buffer.alloc(32, 47).toString("base64");

function withEnv(name: string, value: string | undefined, run: () => void): void {
  const saved = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    run();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

describe("createInstallationStore", () => {
  const closables: Array<{ close: () => Promise<unknown> | unknown }> = [];
  afterEach(async () => {
    while (closables.length > 0) {
      const store = closables.pop();
      if (store) await store.close();
    }
  });

  it("selects SQLite when DATABASE_URL is absent (non-production)", () => {
    withEnv("DATABASE_URL", undefined, () => {
      withEnv("NODE_ENV", "test", () => {
        const store = createInstallationStore({ storeKey: STORE_KEY, sqlitePath: ":memory:" });
        expect(store).toBeInstanceOf(SqliteInstallationStore);
        closables.push(store as SqliteInstallationStore);
      });
    });
  });

  it("refuses SQLite in production with a clear message", () => {
    withEnv("DATABASE_URL", undefined, () => {
      withEnv("NODE_ENV", "production", () => {
        expect(() => createInstallationStore({ storeKey: STORE_KEY, sqlitePath: ":memory:" })).toThrow(
          /Refusing to start on SQLite in production.*DATABASE_URL/,
        );
      });
    });
  });

  it("selects Postgres when DATABASE_URL is set — even in production (no connection on construct)", async () => {
    withEnv("NODE_ENV", "production", () => {
      const store = createInstallationStore({
        storeKey: STORE_KEY,
        databaseUrl: "postgresql://user:pass@localhost:5432/fake_db_for_selection_test",
      });
      expect(store).toBeInstanceOf(PostgresInstallationStore);
      closables.push(store as PostgresInstallationStore);
    });
  });

  it("throws without a connectionString or a shared pool", () => {
    expect(() => new PostgresInstallationStore({ storeKey: STORE_KEY })).toThrow(
      /needs a connectionString or a shared pool/,
    );
  });
});

describe("normalisePid", () => {
  it("renders numbers and numeric strings in canonical integer-string form", () => {
    expect(normalisePid(1021)).toBe("1021");
    expect(normalisePid(1021.0)).toBe("1021");
    expect(normalisePid(1021.9)).toBe("1021");
    expect(normalisePid("1021.0")).toBe("1021");
    expect(normalisePid("  1021 ")).toBe("1021");
    expect(normaliseNullablePid(1205)).toBe("1205");
    expect(normaliseNullablePid("1205.0")).toBe("1205");
  });

  it("passes non-numeric pids through untouched so unknown shapes fail closed", () => {
    // Anything that is not a number never equals a proxy `kid`, so the
    // proxy 401s `unknown_installation` instead of matching the wrong row.
    expect(normalisePid("inst_abc")).toBe("inst_abc");
    expect(normalisePid("")).toBe("");
    expect(normalisePid(Number.NaN)).toBe("NaN");
    expect(normalisePid(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(normalisePid(null)).toBe("null");
    expect(normaliseNullablePid(null)).toBeNull();
    expect(normaliseNullablePid(undefined)).toBeNull();
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
const describePg = DATABASE_URL ? describe : describe.skip;

describePg("createInstallationStore with a shared pool", () => {
  it("a provided pool wins and close() never ends it", async () => {
    const pool = createPostgresPool(DATABASE_URL as string, 2);
    try {
      const store = createInstallationStore({ storeKey: STORE_KEY, pool });
      expect(store).toBeInstanceOf(PostgresInstallationStore);
      // A unique claim proves the store runs queries on the shared pool
      // without asserting anything about other suites' rows.
      const claim = `evt-shared-pool-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
      expect(await store.claimWebhookId(claim)).toBe(true);
      await store.close();
      // Still usable: the store never ends a pool it does not own.
      expect(await store.hasSeenWebhookId(claim)).toBe(true);
      await store.releaseWebhookId(claim);
      await pool.query("SELECT 1");
    } finally {
      await pool.end();
    }
  });
});
