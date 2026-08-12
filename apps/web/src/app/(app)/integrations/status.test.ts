// P4 Task 9: "Integration status trung thực" -- the reported status must
// reflect what has actually been verified, never what is merely
// configured. See status.ts's own header for the four-way distinction this
// pins.
import { describe, expect, it } from "vitest";
import { ALL_KNOWN_PROVIDERS, IMPLEMENTED_PROVIDERS, describeIntegration } from "./status.ts";

describe("describeIntegration", () => {
  it("labels a sandbox-verified integration as verified-in-sandbox, never as merely connected", () => {
    const d = describeIntegration({ provider: "meta", status: "sandbox" });
    expect(d.badge).toBe("Sandbox (đã xác minh)");
    expect(d.canConnect).toBe(false);
  });

  it("labels an unimplemented provider honestly and offers no connect button", () => {
    const d = describeIntegration({ provider: "tiktok", status: "not_implemented" });
    expect(d.badge).toBe("Chưa triển khai");
    expect(d.canConnect).toBe(false);
  });

  it("never returns a connect affordance for a provider with no adapter, whatever its stored status says", () => {
    for (const provider of ["tiktok", "linkedin", "zalo", "youtube"]) {
      expect(describeIntegration({ provider, status: "not_implemented" }).canConnect).toBe(false);
      // Defensive: even a data-entry mistake that set a bogus "connected"
      // status on a provider with no real adapter must still be refused --
      // canConnect is gated on IMPLEMENTED_PROVIDERS, never on status alone.
      expect(describeIntegration({ provider, status: "connected" }).canConnect).toBe(false);
    }
  });

  it("allows connecting only a real implemented provider that is not yet configured", () => {
    expect(describeIntegration({ provider: "meta", status: "disconnected" }).canConnect).toBe(true);
  });

  // The exact failure this task exists to prevent: a row merely existing
  // (a credential_reference was created) must never be reported with the
  // same claim as an integration that has actually been exercised
  // successfully against the sandbox.
  it("distinguishes 'a row exists' (connected) from 'it was actually verified' (sandbox) in the badge text itself", () => {
    const configured = describeIntegration({ provider: "meta", status: "connected" });
    const verified = describeIntegration({ provider: "meta", status: "sandbox" });
    expect(configured.badge).not.toBe(verified.badge);
    expect(configured.badge).toBe("Đã cấu hình, chưa xác minh");
    // Must not read as an affirmative verification claim -- "chưa xác minh"
    // (not yet verified) is the honest negation, never "đã xác minh".
    expect(configured.badge).not.toMatch(/^Đã xác minh/);
    expect(configured.badge).not.toContain("đã xác minh");
    expect(configured.canConnect).toBe(false);
  });

  it("labels a genuinely disconnected implemented provider honestly", () => {
    expect(describeIntegration({ provider: "meta", status: "disconnected" }).badge).toBe("Chưa kết nối");
  });

  it("IMPLEMENTED_PROVIDERS contains exactly the providers packages/integrations actually has an adapter for", () => {
    expect(IMPLEMENTED_PROVIDERS).toEqual(["meta"]);
  });

  it("ALL_KNOWN_PROVIDERS lists every provider the Integrations page must render, honest ones included", () => {
    expect(ALL_KNOWN_PROVIDERS).toEqual(
      expect.arrayContaining(["meta", "tiktok", "linkedin", "zalo", "youtube"]),
    );
  });
});
