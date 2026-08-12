import { describe, expect, it } from "vitest";
import { redact } from "./redact.ts";

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

  it("preserves count-shaped token fields instead of redacting them", () => {
    expect(redact({ tokensIn: 5, tokensOut: 7 })).toEqual({ tokensIn: 5, tokensOut: 7 });
    expect(redact({ tokenCount: 42 })).toEqual({ tokenCount: 42 });
    expect(redact({ tokensUsed: 3 })).toEqual({ tokensUsed: 3 });
    // snake_case variants
    expect(redact({ tokens_in: 5, tokens_out: 7, token_count: 42 })).toEqual({
      tokens_in: 5,
      tokens_out: 7,
      token_count: 42,
    });
  });

  it("still redacts real token secrets regardless of casing or separator", () => {
    expect(redact({ sessionToken: "x", apiToken: "y", accessToken: "z" })).toEqual({
      sessionToken: "[redacted]",
      apiToken: "[redacted]",
      accessToken: "[redacted]",
    });
    expect(redact({ session_token: "x", refresh_token: "y" })).toEqual({
      session_token: "[redacted]",
      refresh_token: "[redacted]",
    });
  });

  it("redacts a bare field genuinely holding an array of tokens, since it is not count-shaped", () => {
    expect(redact({ tokens: ["a", "b"] })).toEqual({ tokens: "[redacted]" });
    expect(redact({ refreshTokens: ["a", "b"] })).toEqual({ refreshTokens: "[redacted]" });
  });
});
