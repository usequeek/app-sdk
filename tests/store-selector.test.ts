import { afterEach, describe, expect, it } from "vitest";
import { createInstallationStore, PostgresInstallationStore, SqliteInstallationStore } from "../src/store.js";

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
});
