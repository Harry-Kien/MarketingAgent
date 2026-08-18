import { describe, expect, it } from "vitest";
import {
  assertWithinReplyWindow,
  assertBelowComplaintThreshold,
  DEFAULT_COMPLAINT_RATE_THRESHOLD,
  ReplyWindowClosedError,
  ComplaintThresholdExceededError,
} from "./reply-window.ts";

describe("assertWithinReplyWindow", () => {
  const now = new Date("2026-08-18T12:00:00.000Z");

  it("refuses a contact with no inbound message at all", () => {
    expect(() => assertWithinReplyWindow({ lastCustomerMessageAt: null }, now)).toThrow(ReplyWindowClosedError);
  });

  it("allows a send inside the 48-hour free window", () => {
    const lastCustomerMessageAt = new Date(now.getTime() - 60 * 60 * 1000);
    expect(() => assertWithinReplyWindow({ lastCustomerMessageAt }, now)).not.toThrow();
  });

  it("refuses a send past the 48-hour free window even though the 7-day window is still open", () => {
    const lastCustomerMessageAt = new Date(now.getTime() - 49 * 60 * 60 * 1000);
    expect(() => assertWithinReplyWindow({ lastCustomerMessageAt }, now)).toThrow(/48-hour/);
  });

  it("refuses a send past the 7-day OpenAPI window", () => {
    const lastCustomerMessageAt = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    expect(() => assertWithinReplyWindow({ lastCustomerMessageAt }, now)).toThrow(/7-day OpenAPI/);
  });
});

describe("assertBelowComplaintThreshold", () => {
  it("allows a send when the complaint rate is comfortably below threshold", async () => {
    await expect(assertBelowComplaintThreshold(async () => 0.001)).resolves.toBeUndefined();
  });

  it("refuses a send once the complaint rate reaches the default threshold", async () => {
    await expect(assertBelowComplaintThreshold(async () => DEFAULT_COMPLAINT_RATE_THRESHOLD)).rejects.toThrow(
      ComplaintThresholdExceededError,
    );
  });

  it("fails closed when the complaint-rate provider returns a non-finite value", async () => {
    await expect(assertBelowComplaintThreshold(async () => Number.NaN)).rejects.toThrow(ComplaintThresholdExceededError);
  });

  it("refuses a caller-supplied threshold at or above Zalo's own 2% lockout line", async () => {
    await expect(assertBelowComplaintThreshold(async () => 0.001, 0.02)).rejects.toThrow(/threshold must be/);
  });
});
