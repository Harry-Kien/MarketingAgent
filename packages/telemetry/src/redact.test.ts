import { describe, expect, it } from "vitest";
import { redact } from "./redact.js";

describe("redact", () => {
  it("masks sensitive keys at any depth", () => {
    const input = {
      user: "kien",
      password: "hunter2",
      nested: { accessToken: "abc123", apiKey: "sk-live-xyz" },
    };
    expect(redact(input)).toEqual({
      user: "kien",
      password: "[redacted]",
      nested: { accessToken: "[redacted]", apiKey: "[redacted]" },
    });
  });

  it("masks connection strings that embed a password", () => {
    expect(redact("postgres://u:hunter2@localhost:5432/db")).toBe(
      "postgres://u:[redacted]@localhost:5432/db",
    );
  });

  it("walks arrays", () => {
    expect(redact([{ token: "t1" }, { token: "t2" }])).toEqual([
      { token: "[redacted]" },
      { token: "[redacted]" },
    ]);
  });

  it("leaves ordinary values untouched", () => {
    expect(redact({ count: 3, ok: true, name: "campaign" })).toEqual({
      count: 3,
      ok: true,
      name: "campaign",
    });
  });

  it("does not loop forever on circular references", () => {
    const a: Record<string, unknown> = { name: "a" };
    a["self"] = a;
    expect(() => redact(a)).not.toThrow();
  });
});
