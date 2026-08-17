import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KmsProvider, WrappedKey } from "../kms-provider.ts";
import { VaultNotFoundError } from "../errors.ts";

/**
 * An in-memory KmsProvider for unit tests that must not depend on
 * process.env (that's env-kms-provider.test.ts's job). Holds a map of
 * kekId -> 32-byte key entirely in memory; never touches disk, env or a
 * network. Used only under packages/vault/src/**\/*.test.ts.
 */
export function createFakeKmsProvider(activeKeyId = "test-v1"): KmsProvider & { keks: Map<string, Buffer> } {
  const keks = new Map<string, Buffer>([[activeKeyId, randomBytes(32)]]);

  return {
    activeKeyId,
    keks,
    async wrapDataKey(plaintextDataKey: Buffer): Promise<WrappedKey> {
      const kek = keks.get(activeKeyId);
      if (!kek) throw new Error(`fake KMS: no key material for kekId "${activeKeyId}"`);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", kek, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintextDataKey), cipher.final()]);
      return { kekId: activeKeyId, ciphertext, iv, authTag: cipher.getAuthTag() };
    },
    async unwrapDataKey(wrapped: WrappedKey): Promise<Buffer> {
      const kek = keks.get(wrapped.kekId);
      // Same contract as env-kms-provider.ts: a kekId this provider holds no
      // material for is VaultNotFoundError, not a generic Error -- callers
      // (resolveSecret) rely on being able to tell "the wrong/retired key"
      // apart from "the ciphertext itself is tampered" (VaultTamperError).
      if (!kek) throw new VaultNotFoundError(`fake KMS: no key material for kekId "${wrapped.kekId}"`);
      const decipher = createDecipheriv("aes-256-gcm", kek, wrapped.iv);
      decipher.setAuthTag(wrapped.authTag);
      return Buffer.concat([decipher.update(wrapped.ciphertext), decipher.final()]);
    },
  };
}
