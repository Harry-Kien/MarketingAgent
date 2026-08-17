import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KmsProvider, WrappedKey } from "../kms-provider.ts";
import { VaultNotFoundError } from "../errors.ts";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_ENV_PREFIX = "VAULT_KEK_";
const HEX_32_BYTES_RE = /^[0-9a-f]{64}$/i;

/**
 * LOCAL DEVELOPMENT ONLY. This is honestly named for what it is -- a
 * KmsProvider that reads raw key material out of process.env -- and
 * deliberately not named or shaped to resemble a hosted KMS SDK. It has no
 * IAM, no audit log of its own, no HSM, no network call, and anyone who can
 * read this process's environment can read every KEK it holds.
 *
 * A production deployment implements packages/vault/src/kms-provider.ts's
 * KmsProvider interface against a real KMS (AWS KMS, GCP KMS, HashiCorp
 * Vault Transit) instead -- envelope.ts and vault-store.ts depend only on
 * that interface, so nothing else in this package changes when that
 * happens.
 *
 * Configuration (see .env.example):
 *   VAULT_KEK_<ID>       -- 32 bytes, hex-encoded (64 hex chars), one per
 *                            KEK version. <ID> becomes the lowercased kekId.
 *   VAULT_ACTIVE_KEK_ID  -- which version wraps NEW data keys. Must name a
 *                            VAULT_KEK_<ID> that is actually set.
 *
 * Every other configured VAULT_KEK_* stays available for unwrapDataKey, so
 * a row wrapped under an older version keeps working right up until it is
 * explicitly rotated (packages/vault/src/vault-store.ts's
 * rotateSecretKek) -- retiring a KEK version is deleting its env var, which
 * this provider then correctly reports as VaultNotFoundError for any row
 * still wrapped under it.
 */
export function createEnvKmsProvider(env: Record<string, string | undefined> = process.env): KmsProvider {
  const keks = new Map<string, Buffer>();
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(KEY_ENV_PREFIX) || value === undefined) continue;
    const id = name.slice(KEY_ENV_PREFIX.length).toLowerCase();
    if (!HEX_32_BYTES_RE.test(value)) {
      throw new Error(
        `EnvKmsProvider: ${name} must be 32 bytes hex-encoded (64 hex characters); refusing to start with malformed key material`,
      );
    }
    keks.set(id, Buffer.from(value, "hex"));
  }
  if (keks.size === 0) {
    throw new Error(
      "EnvKmsProvider: no VAULT_KEK_* environment variables are set. At least one key-encryption key is required.",
    );
  }

  const rawActiveKeyId = env["VAULT_ACTIVE_KEK_ID"];
  if (rawActiveKeyId === undefined || rawActiveKeyId.length === 0) {
    throw new Error("EnvKmsProvider: VAULT_ACTIVE_KEK_ID is not set.");
  }
  const activeKeyId = rawActiveKeyId.toLowerCase();
  if (!keks.has(activeKeyId)) {
    throw new Error(
      `EnvKmsProvider: VAULT_ACTIVE_KEK_ID names "${activeKeyId}", but no VAULT_KEK_${rawActiveKeyId.toUpperCase()} is set.`,
    );
  }

  return {
    activeKeyId,
    async wrapDataKey(plaintextDataKey: Buffer): Promise<WrappedKey> {
      // Non-null assertion is safe: activeKeyId is verified present above,
      // at construction time, and keks is never mutated after that.
      const kek = keks.get(activeKeyId)!;
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, kek, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintextDataKey), cipher.final()]);
      return { kekId: activeKeyId, ciphertext, iv, authTag: cipher.getAuthTag() };
    },
    async unwrapDataKey(wrapped: WrappedKey): Promise<Buffer> {
      const kek = keks.get(wrapped.kekId);
      if (!kek) {
        throw new VaultNotFoundError(
          `EnvKmsProvider: no key material for kekId "${wrapped.kekId}" (retired or never configured)`,
        );
      }
      const decipher = createDecipheriv(ALGORITHM, kek, wrapped.iv);
      decipher.setAuthTag(wrapped.authTag);
      return Buffer.concat([decipher.update(wrapped.ciphertext), decipher.final()]);
    },
  };
}
