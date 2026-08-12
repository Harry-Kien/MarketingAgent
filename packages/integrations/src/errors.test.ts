import { describe, expect, it } from "vitest";
import { AdapterError, ERROR_KINDS, isRetryable } from "./errors.ts";

describe("error taxonomy", () => {
  it("covers the six kinds an operator must distinguish", () => {
    expect(ERROR_KINDS).toEqual([
      "auth_expired",
      "rate_limited",
      "invalid_input",
      "quota_exceeded",
      "upstream_unavailable",
      "permanent_rejection",
    ]);
  });

  it("marks transient kinds retryable and permanent kinds not", () => {
    expect(isRetryable("rate_limited")).toBe(true);
    expect(isRetryable("upstream_unavailable")).toBe(true);
    expect(isRetryable("invalid_input")).toBe(false);
    expect(isRetryable("permanent_rejection")).toBe(false);
    expect(isRetryable("auth_expired")).toBe(false);
  });

  it("carries retryAfterMs for rate limiting", () => {
    const e = new AdapterError("rate_limited", "slow down", { retryAfterMs: 5000 });
    expect(e.retryAfterMs).toBe(5000);
    expect(e.retryable).toBe(true);
  });

  it("never puts a token in the message", () => {
    const e = new AdapterError("auth_expired", "token EAAxxxxx expired");
    expect(e.safeMessage).not.toContain("EAAxxxxx");
  });
});
