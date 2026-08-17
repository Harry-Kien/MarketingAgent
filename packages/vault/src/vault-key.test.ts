import { describe, expect, it } from "vitest";
import { newId } from "@smos/domain";
import { buildVaultKey, parseVaultKey } from "./vault-key.ts";
import { VaultKeyMismatchError } from "./errors.ts";

describe("buildVaultKey / parseVaultKey", () => {
  it("round-trips workspaceId and slug", () => {
    const workspaceId = newId();
    const key = buildVaultKey(workspaceId, "meta-webhook-secret");
    expect(key).toBe(`vault://${workspaceId}/meta-webhook-secret`);
    expect(parseVaultKey(key)).toEqual({ workspaceId, slug: "meta-webhook-secret" });
  });

  it("accepts a slug containing hyphens, underscores and dots", () => {
    const workspaceId = newId();
    const key = buildVaultKey(workspaceId, "meta.ads_access-token.v2");
    expect(parseVaultKey(key)).toEqual({ workspaceId, slug: "meta.ads_access-token.v2" });
  });

  it.each([
    ["missing scheme", "not-a-vault-key"],
    ["http scheme", "http://019ff775-f7f6-7e31-9114-45c0fb0e8fd2/slug"],
    ["missing slug", "vault://019ff775-f7f6-7e31-9114-45c0fb0e8fd2"],
    ["missing slug with trailing slash", "vault://019ff775-f7f6-7e31-9114-45c0fb0e8fd2/"],
    ["workspace id is not a valid Id", "vault://not-a-real-id/slug"],
    ["empty string", ""],
    ["extra path segments", "vault://019ff775-f7f6-7e31-9114-45c0fb0e8fd2/slug/extra"],
  ])("rejects a malformed vault key: %s", (_label, raw) => {
    expect(() => parseVaultKey(raw)).toThrow(VaultKeyMismatchError);
  });

  it("rejects a slug that is only whitespace", () => {
    const workspaceId = newId();
    expect(() => parseVaultKey(`vault://${workspaceId}/   `)).toThrow(VaultKeyMismatchError);
  });
});
