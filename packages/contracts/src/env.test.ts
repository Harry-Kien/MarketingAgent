import { describe, expect, it } from "vitest";
import { parseServerEnv } from "./env.ts";

const valid = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://user:pw@127.0.0.1:5432/smos",
  OTEL_SERVICE_NAME: "smos-test",
};

describe("parseServerEnv", () => {
  it("accepts a valid environment", () => {
    const env = parseServerEnv(valid);
    expect(env.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(env.NODE_ENV).toBe("test");
  });

  it("rejects a missing DATABASE_URL", () => {
    const { DATABASE_URL, ...missing } = valid;
    void DATABASE_URL;
    expect(() => parseServerEnv(missing)).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() => parseServerEnv({ ...valid, DATABASE_URL: "mysql://x" })).toThrow(/postgres/);
  });

  it("never includes the raw secret in the thrown message", () => {
    try {
      parseServerEnv({ ...valid, DATABASE_URL: "mysql://user:SUPERSECRET@h/db" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(String(error)).not.toContain("SUPERSECRET");
    }
  });

  // Final whole-branch review, FINDING 7. DATABASE_WORKER_URL is optional
  // here (apps/web has no reason to ever hold it -- only apps/worker's own
  // draining path does), but when present it must be validated the same
  // way DATABASE_URL is: a real postgres connection string, not silently
  // accepted as anything.
  it("accepts an environment with no DATABASE_WORKER_URL at all (optional)", () => {
    const env = parseServerEnv(valid);
    expect(env.DATABASE_WORKER_URL).toBeUndefined();
  });

  it("accepts a valid DATABASE_WORKER_URL", () => {
    const withWorkerUrl = { ...valid, DATABASE_WORKER_URL: "postgres://smos_worker:pw@127.0.0.1:5433/smos" };
    const env = parseServerEnv(withWorkerUrl);
    expect(env.DATABASE_WORKER_URL).toBe(withWorkerUrl.DATABASE_WORKER_URL);
  });

  it("rejects a non-postgres DATABASE_WORKER_URL", () => {
    expect(() => parseServerEnv({ ...valid, DATABASE_WORKER_URL: "mysql://x" })).toThrow(
      /DATABASE_WORKER_URL/,
    );
  });
});
