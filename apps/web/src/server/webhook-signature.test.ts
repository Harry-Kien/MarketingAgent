import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySignature } from "./webhook-signature.ts";

const secret = "sandbox-secret";
const body = JSON.stringify({ object: "page", entry: [] });
const sign = (b: string) => "sha256=" + createHmac("sha256", secret).update(b).digest("hex");

describe("verifySignature", () => {
  it("accepts a correct signature", () => {
    expect(verifySignature(body, sign(body), secret)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifySignature(body + "x", sign(body), secret)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifySignature(body, "", secret)).toBe(false);
  });

  it("rejects a wrong algorithm prefix", () => {
    expect(verifySignature(body, "sha1=" + createHmac("sha1", secret).update(body).digest("hex"), secret)).toBe(
      false,
    );
  });

  it("uses a constant-time comparison", () => {
    // Length mismatch must not throw; it must simply return false.
    expect(() => verifySignature(body, "sha256=aa", secret)).not.toThrow();
    expect(verifySignature(body, "sha256=aa", secret)).toBe(false);
  });

  it("rejects a signature signed with the wrong secret", () => {
    expect(verifySignature(body, sign(body), "some-other-secret")).toBe(false);
  });

  it("rejects a header that is not valid hex after the prefix", () => {
    expect(verifySignature(body, "sha256=not-hex-zzzz", secret)).toBe(false);
  });

  it("rejects an empty body signed against a non-empty one", () => {
    expect(verifySignature("", sign(body), secret)).toBe(false);
  });

  it("accepts an empty body signed correctly", () => {
    expect(verifySignature("", sign(""), secret)).toBe(true);
  });

  it("is case-insensitive on the hex signature", () => {
    const sig = sign(body).replace("sha256=", "");
    expect(verifySignature(body, `sha256=${sig.toUpperCase()}`, secret)).toBe(true);
  });
});
