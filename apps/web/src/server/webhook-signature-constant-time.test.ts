// Late-review IMPORTANT 5: the constant-time comparison was not locked.
//
// Replacing
//
//   return timingSafeEqual(providedBuf, expectedBuf);
//
// with
//
//   return provided.toLowerCase() === expectedHex;
//
// caused ZERO failures across 1433 tests -- including the test named
// `verifySignature > uses a constant-time comparison`, which only asserted
// that a length mismatch does not throw. Both implementations agree on every
// input/output pair, because they differ in TIMING, not in result; a test
// that can only see the boolean can never tell them apart. Every other test
// in webhook-signature.test.ts is likewise value-based and always will be.
//
// So this file observes the mechanism instead of the value. `node:crypto` is
// mocked with a pass-through spy that still delegates to the real
// implementation -- nothing about the comparison's behaviour changes, we can
// simply see whether it happened. `===` on strings is variable-time by
// construction (V8 compares byte by byte and returns at the first
// difference), so "did the constant-time primitive actually run, over the
// full digest, on the paths that matter" is exactly the property at stake,
// and it is one a boolean assertion cannot reach.
//
// Why not measure wall-clock timing instead: a real timing test on a 32-byte
// digest is measuring nanoseconds against a JIT, a GC and a shared CI
// machine. It would be flaky in both directions -- red on a noisy runner,
// green against a genuinely leaky implementation -- and a flaky security
// test gets muted, which is worse than no test. This one is deterministic.
//
// The mock is confined to this file precisely so webhook-signature.test.ts
// keeps exercising the real, unmocked function for every value-based
// assertion it makes.
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const timingSafeEqualSpy = vi.fn();

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      timingSafeEqualSpy(a, b);
      return actual.timingSafeEqual(a, b);
    },
  };
});

const { verifySignature, deriveWorkspaceSecret } = await import("./webhook-signature.ts");

const secret = "sandbox-secret";
const body = JSON.stringify({ object: "page", entry: [] });
const validHex = createHmac("sha256", secret).update(body).digest("hex");

beforeEach(() => {
  timingSafeEqualSpy.mockClear();
});

describe("verifySignature performs the comparison in constant time", () => {
  it("delegates the accept decision to timingSafeEqual over the full 32-byte digest", () => {
    expect(verifySignature(body, `sha256=${validHex}`, secret)).toBe(true);

    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
    const [provided, expected] = timingSafeEqualSpy.mock.calls[0] as [Buffer, Buffer];
    expect(Buffer.isBuffer(provided)).toBe(true);
    expect(Buffer.isBuffer(expected)).toBe(true);
    // The whole digest, never a prefix: comparing fewer bytes would be
    // constant-time over the wrong thing.
    expect(provided).toHaveLength(32);
    expect(expected).toHaveLength(32);
    expect(expected.toString("hex")).toBe(validHex);
  });

  it("delegates the REJECT decision too, for a same-length signature that differs in its first byte", () => {
    // The variable-time replacement returns false here after comparing ONE
    // character. This assertion is what fails when that happens.
    const firstByteDiffers = (validHex[0] === "0" ? "1" : "0") + validHex.slice(1);
    expect(verifySignature(body, `sha256=${firstByteDiffers}`, secret)).toBe(false);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });

  it("delegates the REJECT decision for a signature that differs only in its LAST byte", () => {
    // Paired with the test above on purpose: a variable-time comparison
    // takes measurably longer on this input than on that one, and that
    // difference is the whole attack. Both must reach the same primitive.
    const lastByteDiffers = validHex.slice(0, -1) + (validHex.at(-1) === "0" ? "1" : "0");
    expect(verifySignature(body, `sha256=${lastByteDiffers}`, secret)).toBe(false);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });

  it("never calls it with mismatched lengths, which would throw", () => {
    expect(verifySignature(body, "sha256=aa", secret)).toBe(false);
    expect(timingSafeEqualSpy).not.toHaveBeenCalled();
  });

  it("compares under the workspace-derived secret, so the timing-safe path is the one the route uses", () => {
    const workspaceId = "019ff775-f7f6-7e31-9114-45c0fb0e8fd2";
    const workspaceSecret = deriveWorkspaceSecret(secret, workspaceId);
    const hex = createHmac("sha256", workspaceSecret).update(body).digest("hex");
    expect(verifySignature(body, `sha256=${hex}`, workspaceSecret)).toBe(true);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });
});
