/**
 * A wrapped (encrypted) data key, as produced by a KmsProvider and as stored
 * verbatim in vault_secret's wrapped_data_key/wrap_iv/wrap_auth_tag/kek_id
 * columns (0036_vault_secret.sql). Never holds plaintext key material.
 */
export interface WrappedKey {
  /** Which key-encryption key (KEK) version wrapped this data key. */
  readonly kekId: string;
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
}

/**
 * The seam between this vault and whatever actually holds key-encryption
 * keys (KEKs). Deliberately narrow: two operations, both over a data key
 * (32 random bytes), never over the secret itself -- a KmsProvider
 * implementation never sees a plaintext secret, only data keys, so even a
 * fully compromised provider only ever exposes what a specific wrapped data
 * key unwraps to, not the plaintext ciphertext columns it did not touch.
 *
 * `packages/vault/src/providers/env-kms-provider.ts` is the ONLY
 * implementation in this milestone, and it is local-development-only by
 * name and by header -- it is not, and must never be mistaken for, a real
 * hosted KMS. A production deployment implements this same interface
 * against AWS KMS / GCP KMS / HashiCorp Vault Transit and nothing else in
 * this package changes: envelope.ts and vault-store.ts depend only on this
 * interface, never on any concrete provider.
 */
export interface KmsProvider {
  /** The KEK version new data keys are wrapped under right now. */
  readonly activeKeyId: string;

  /** Encrypt (wrap) a plaintext data key under the active KEK version. */
  wrapDataKey(plaintextDataKey: Buffer): Promise<WrappedKey>;

  /**
   * Decrypt (unwrap) a data key that was wrapped under `wrapped.kekId`.
   * Contract every implementation must honour: reject with
   * `VaultNotFoundError` (packages/vault/src/errors.ts) specifically when
   * this provider holds no key material for `wrapped.kekId` -- a retired or
   * never-configured KEK version -- so callers (resolveSecret) can tell
   * that apart from ciphertext genuinely failing authentication
   * (`VaultTamperError`, raised by envelope.ts, not here).
   */
  unwrapDataKey(wrapped: WrappedKey): Promise<Buffer>;
}
