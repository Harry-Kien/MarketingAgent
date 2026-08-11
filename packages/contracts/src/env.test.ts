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
});
