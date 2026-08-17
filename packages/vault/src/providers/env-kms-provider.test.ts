// EnvKmsProvider: the LOCAL DEVELOPMENT KmsProvider implementation. Reads
// KEK material from process environment (never a database, never the
// ciphertext table) -- this file proves the parsing/validation contract and
// the wrap/unwrap round trip against real node:crypto, entirely in memory.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { VaultNotFoundError } from "../errors.ts";
import { createEnvKmsProvider } from "./env-kms-provider.ts";

const V1 = randomBytes(32).toString("hex");
const V2 = randomBytes(32).toString("hex");

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    VAULT_KEK_V1: V1,
    VAULT_KEK_V2: V2,
    VAULT_ACTIVE_KEK_ID: "v1",
    ...overrides,
  };
}

describe("createEnvKmsProvider", () => {
  it("exposes the configured active key id", () => {
    const kms = createEnvKmsProvider(env());
    expect(kms.activeKeyId).toBe("v1");
  });

  it("wraps under the active key and round-trips through unwrap", async () => {
    const kms = createEnvKmsProvider(env());
    const dataKey = randomBytes(32);
    const wrapped = await kms.wrapDataKey(dataKey);
    expect(wrapped.kekId).toBe("v1");
    const unwrapped = await kms.unwrapDataKey(wrapped);
    expect(unwrapped.equals(dataKey)).toBe(true);
  });

  it("unwraps a key wrapped under a NON-active version (rotation support)", async () => {
    const kms = createEnvKmsProvider(env({ VAULT_ACTIVE_KEK_ID: "v2" }));
    // Wrapped by a provider whose active key was v1 (an older wrap, as
    // stored in a row nobody has rotated yet).
    const olderProvider = createEnvKmsProvider(env({ VAULT_ACTIVE_KEK_ID: "v1" }));
    const dataKey = randomBytes(32);
    const wrappedUnderV1 = await olderProvider.wrapDataKey(dataKey);
    expect(wrappedUnderV1.kekId).toBe("v1");

    // kms's active key is v2, but it still holds v1's material (both env
    // vars are present) -- so it can unwrap an old row without rotating it
    // first.
    const unwrapped = await kms.unwrapDataKey(wrappedUnderV1);
    expect(unwrapped.equals(dataKey)).toBe(true);
  });

  it("two different data keys produce different wrapped ciphertext (fresh IV per wrap)", async () => {
    const kms = createEnvKmsProvider(env());
    const a = await kms.wrapDataKey(randomBytes(32));
    const b = await kms.wrapDataKey(randomBytes(32));
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  it("throws VaultNotFoundError when unwrapping a kekId this provider holds no material for", async () => {
    const kms = createEnvKmsProvider(env());
    const dataKey = randomBytes(32);
    const wrapped = await kms.wrapDataKey(dataKey);
    const forged = { ...wrapped, kekId: "v99-does-not-exist" };
    await expect(kms.unwrapDataKey(forged)).rejects.toThrow(VaultNotFoundError);
  });

  it("throws at construction when VAULT_ACTIVE_KEK_ID names a key with no matching VAULT_KEK_* entry", () => {
    expect(() => createEnvKmsProvider(env({ VAULT_ACTIVE_KEK_ID: "v-missing" }))).toThrow(/v-missing/i);
  });

  it("throws at construction when no VAULT_KEK_* variables are set at all", () => {
    expect(() =>
      createEnvKmsProvider({ VAULT_ACTIVE_KEK_ID: "v1" }),
    ).toThrow(/VAULT_KEK/);
  });

  it("throws at construction when a KEK value is not valid 32-byte hex", () => {
    expect(() => createEnvKmsProvider(env({ VAULT_KEK_V1: "not-hex-and-too-short" }))).toThrow(/VAULT_KEK_V1/);
  });

  it("throws at construction when VAULT_ACTIVE_KEK_ID is missing entirely", () => {
    expect(() => createEnvKmsProvider(env({ VAULT_ACTIVE_KEK_ID: undefined }))).toThrow(/VAULT_ACTIVE_KEK_ID/);
  });

  it("is case-insensitive on the key id (v1 == V1 == V001? no -- exact, lowercased) and normalizes to lowercase", async () => {
    const kms = createEnvKmsProvider(env({ VAULT_ACTIVE_KEK_ID: "V1" }));
    expect(kms.activeKeyId).toBe("v1");
  });
});
