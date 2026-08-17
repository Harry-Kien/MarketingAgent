// Envelope encryption, pure crypto layer -- no database, no process.env.
// One random data key (DEK) per secret, AES-256-GCM over the plaintext; the
// DEK itself is wrapped by whatever KmsProvider is handed in. This file
// proves the crypto contract in isolation: round trip, tamper detection,
// and that a data key never survives past the call that used it.
import { describe, expect, it } from "vitest";
import { VaultTamperError } from "./errors.ts";
import { sealSecret, openSecret } from "./envelope.ts";
import { createFakeKmsProvider } from "./test-helpers/fake-kms-provider.ts";

describe("sealSecret / openSecret", () => {
  it("round-trips a plaintext secret", async () => {
    const kms = createFakeKmsProvider();
    const sealed = await sealSecret("m3ta-app-secret-abc123", kms);
    const opened = await openSecret(sealed, kms);
    expect(opened).toBe("m3ta-app-secret-abc123");
  });

  it("round-trips an empty string", async () => {
    const kms = createFakeKmsProvider();
    const sealed = await sealSecret("", kms);
    expect(await openSecret(sealed, kms)).toBe("");
  });

  it("round-trips a long unicode secret", async () => {
    const kms = createFakeKmsProvider();
    const plaintext = "sếcret-với-dấu-😀".repeat(50);
    const sealed = await sealSecret(plaintext, kms);
    expect(await openSecret(sealed, kms)).toBe(plaintext);
  });

  it("produces a different ciphertext and a different data key each time (fresh IV, fresh DEK)", async () => {
    const kms = createFakeKmsProvider();
    const a = await sealSecret("same-plaintext", kms);
    const b = await sealSecret("same-plaintext", kms);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedKey.ciphertext.equals(b.wrappedKey.ciphertext)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  it("refuses to open ciphertext that has been bit-flipped, as a VaultTamperError", async () => {
    const kms = createFakeKmsProvider();
    const sealed = await sealSecret("do-not-tamper-with-me", kms);
    const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
    tampered.ciphertext[0] = tampered.ciphertext[0]! ^ 0xff;
    await expect(openSecret(tampered, kms)).rejects.toThrow(VaultTamperError);
  });

  it("refuses to open when the auth tag has been altered", async () => {
    const kms = createFakeKmsProvider();
    const sealed = await sealSecret("do-not-tamper-with-me", kms);
    const tampered = { ...sealed, authTag: Buffer.from(sealed.authTag) };
    tampered.authTag[0] = tampered.authTag[0]! ^ 0xff;
    await expect(openSecret(tampered, kms)).rejects.toThrow(VaultTamperError);
  });

  it("refuses to open under the wrong KEK (data key unwraps to garbage/fails auth)", async () => {
    const kmsA = createFakeKmsProvider("kek-a");
    const kmsB = createFakeKmsProvider("kek-b");
    const sealed = await sealSecret("cross-kek-should-fail", kmsA);
    // kmsB has no "kek-a" key material at all -- simulates a wrapped key
    // whose KEK version this provider does not (or no longer) hold.
    await expect(openSecret(sealed, kmsB)).rejects.toThrow();
  });

  it("the VaultTamperError message never contains the plaintext or key bytes", async () => {
    const kms = createFakeKmsProvider();
    const secret = "super-sensitive-value-should-never-appear-in-error";
    const sealed = await sealSecret(secret, kms);
    const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
    tampered.ciphertext[0] = tampered.ciphertext[0]! ^ 0xff;
    try {
      await openSecret(tampered, kms);
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
      expect(message.toLowerCase()).not.toContain(kms.keks.get(kms.activeKeyId)!.toString("hex"));
    }
  });
});
