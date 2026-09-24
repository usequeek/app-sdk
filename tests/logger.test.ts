import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";

describe("structured logger", () => {
  function capture(level = "info" as const) {
    const lines: string[] = [];
    const log = createLogger({
      service: "test",
      level,
      sink: (line) => {
        lines.push(line);
      },
    });
    return { log, lines };
  }

  it("emits one JSON line per call with service and level", () => {
    const { log, lines } = capture();
    log.info("installed", { store: "store_xyz", installation: "inst_abc" });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed.service).toBe("test");
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("installed");
    expect(parsed.store).toBe("store_xyz");
    expect(typeof parsed.ts).toBe("string");
  });

  it("redacts secret-shaped fields and values, in fields and messages", () => {
    const { log, lines } = capture();
    log.info("proof-call with sk_test_abc123XYZ failed", {
      installation: "inst_abc",
      api_key: "sk_test_abc123XYZ",
      webhook_secret: "whsec_c2VjcmV0dmVjcmV0c2VjcmV0",
      nested: { token: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig", keep: "yes" },
    });
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed.api_key).toBe("[redacted]");
    expect(parsed.webhook_secret).toBe("[redacted]");
    expect((parsed.nested as Record<string, unknown>).token).toBe("[redacted]");
    expect((parsed.nested as Record<string, unknown>).keep).toBe("yes");
    expect(parsed.installation).toBe("inst_abc");
    expect(parsed.msg).not.toContain("sk_test_abc123XYZ");
    expect(parsed.msg).toContain("[redacted]");
  });

  it("gates below the configured level", () => {
    const { log, lines } = capture("warn");
    log.debug("quiet");
    log.info("quiet");
    log.warn("loud");
    log.error("louder");
    expect(lines).toHaveLength(2);
  });
});
