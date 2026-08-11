import { describe, expect, it } from "vitest";
import { checkHealth } from "./health.ts";

const ok = (): Promise<void> => Promise.resolve();
const fail = (message: string) => (): Promise<void> => Promise.reject(new Error(message));

describe("checkHealth", () => {
  it("reports ok when every dependency answers", async () => {
    const report = await checkHealth({ pingDb: ok, pingQueue: ok });
    expect(report.status).toBe("ok");
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  it("reports degraded and names the failing dependency", async () => {
    const report = await checkHealth({ pingDb: fail("db down"), pingQueue: ok });
    expect(report.status).toBe("degraded");
    expect(report.checks.find((c) => c.name === "database")?.ok).toBe(false);
  });

  it("never leaks a connection string password in the error field", async () => {
    const report = await checkHealth({
      pingDb: fail("connect ECONNREFUSED postgres://u:hunter2@h:5432/db"),
      pingQueue: ok,
    });
    expect(JSON.stringify(report)).not.toContain("hunter2");
  });

  it("keeps probing every dependency even when the first one fails", async () => {
    const report = await checkHealth({ pingDb: fail("db down"), pingQueue: fail("queue down") });
    expect(report.checks).toHaveLength(2);
    expect(report.checks.every((c) => !c.ok)).toBe(true);
  });
});
