import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KmsProvider, WrappedKey } from "./kms-provider.ts";
import { VaultTamperError } from "./errors.ts";

const ALGORITHM = "aes-256-gcm";
const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * The two ciphertexts envelope encryption produces: the secret itself,
 * encrypted under a one-time data key, and that data key, wrapped by
 * whatever KmsProvider sealed it. This is exactly the shape
 * vault_secret's columns hold (0036_vault_secret.sql) -- this type and that
 * table are meant to be read side by side.
 */
export interface SealedSecret {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly wrappedKey: WrappedKey;
}

/**
 * Encrypt `plaintext` under a fresh, random 256-bit data key (DEK), then
 * immediately wrap that DEK with `kms` -- the plaintext DEK never leaves
 * this function's stack frame and is zeroed before returning, best-effort
 * (Node/V8 offers no hard guarantee a GC hasn't copied the buffer
 * elsewhere, but this closes the ordinary "left lying around in a variable
 * a debugger or a later bug reads" case).
 *
 * A fresh DEK per call, not a hierarchy where every secret in a workspace
 * shares one key, is the actual value envelope encryption buys here: one
 * ciphertext leaking (or one specific data key leaking, since it is stored
 * wrapped, not plaintext) never exposes any other secret's data key.
 */
export async function sealSecret(plaintext: string, kms: KmsProvider): Promise<SealedSecret> {
  const dataKey = randomBytes(DATA_KEY_BYTES);
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, dataKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const wrappedKey = await kms.wrapDataKey(dataKey);
    return { ciphertext, iv, authTag, wrappedKey };
  } finally {
    dataKey.fill(0);
  }
}

/**
 * The inverse of sealSecret: unwrap the data key via `kms`, then decrypt.
 * AES-GCM's auth tag covers both tamper detection and "wrong key" in one
 * mechanism -- there is no way to distinguish "someone flipped a bit in
 * ciphertext" from "this was wrapped/unwrapped under the wrong KEK" from
 * the outside, and this function deliberately does not try to: both surface
 * as the same VaultTamperError, with no ciphertext, plaintext or key bytes
 * in its message (T4).
 */
export async function openSecret(sealed: SealedSecret, kms: KmsProvider): Promise<string> {
  const dataKey = await kms.unwrapDataKey(sealed.wrappedKey);
  try {
    const decipher = createDecipheriv(ALGORITHM, dataKey, sealed.iv);
    decipher.setAuthTag(sealed.authTag);
    try {
      const plaintext = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
      return plaintext.toString("utf8");
    } catch {
      // node:crypto's own error here can carry no key material -- GCM
      // authentication failure carries none by construction -- but the
      // message text ("Unsupported state or unable to authenticate data")
      // is an internal detail worth not depending on, so it is replaced
      // outright rather than wrapped.
      throw new VaultTamperError(
        "vault: ciphertext failed authentication -- tampered, corrupted, or sealed under a different key",
      );
    }
  } finally {
    dataKey.fill(0);
  }
}
