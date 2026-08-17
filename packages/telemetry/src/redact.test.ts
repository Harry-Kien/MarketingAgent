import { describe, expect, it } from "vitest";
import { redact } from "./redact.ts";

describe("redact", () => {
  it("masks sensitive keys at any depth", () => {
    const input = {
      user: "kien",
      password: "hunter2",
      nested: { accessToken: "abc123", apiKey: "sk-live-xyz" },
    };
    expect(redact(input)).toEqual({
      user: "kien",
      password: "[redacted]",
      nested: { accessToken: "[redacted]", apiKey: "[redacted]" },
    });
  });

  it("masks connection strings that embed a password", () => {
    expect(redact("postgres://u:hunter2@localhost:5432/db")).toBe(
      "postgres://u:[redacted]@localhost:5432/db",
    );
  });

  it("walks arrays", () => {
    expect(redact([{ token: "t1" }, { token: "t2" }])).toEqual([
      { token: "[redacted]" },
      { token: "[redacted]" },
    ]);
  });

  it("leaves ordinary values untouched", () => {
    expect(redact({ count: 3, ok: true, name: "campaign" })).toEqual({
      count: 3,
      ok: true,
      name: "campaign",
    });
  });

  it("does not loop forever on circular references", () => {
    const a: Record<string, unknown> = { name: "a" };
    a["self"] = a;
    expect(() => redact(a)).not.toThrow();
  });

  it("preserves count-shaped token fields instead of redacting them", () => {
    expect(redact({ tokensIn: 5, tokensOut: 7 })).toEqual({ tokensIn: 5, tokensOut: 7 });
    expect(redact({ tokenCount: 42 })).toEqual({ tokenCount: 42 });
    expect(redact({ tokensUsed: 3 })).toEqual({ tokensUsed: 3 });
    // snake_case variants
    expect(redact({ tokens_in: 5, tokens_out: 7, token_count: 42 })).toEqual({
      tokens_in: 5,
      tokens_out: 7,
      token_count: 42,
    });
  });

  it("still redacts real token secrets regardless of casing or separator", () => {
    expect(redact({ sessionToken: "x", apiToken: "y", accessToken: "z" })).toEqual({
      sessionToken: "[redacted]",
      apiToken: "[redacted]",
      accessToken: "[redacted]",
    });
    expect(redact({ session_token: "x", refresh_token: "y" })).toEqual({
      session_token: "[redacted]",
      refresh_token: "[redacted]",
    });
  });

  it("redacts a bare field genuinely holding an array of tokens, since it is not count-shaped", () => {
    expect(redact({ tokens: ["a", "b"] })).toEqual({ tokens: "[redacted]" });
    expect(redact({ refreshTokens: ["a", "b"] })).toEqual({ refreshTokens: "[redacted]" });
  });

  it("redacts all-lowercase concatenated token secrets, which have no camelCase/snake_case word boundary", () => {
    const input = {
      accesstoken: "SECRET1",
      authtoken: "SECRET2",
      sessiontoken: "SECRET3",
      csrftoken: "SECRET4",
      bearertoken: "SECRET5",
      usertoken: "SECRET6",
      clienttoken: "SECRET7",
      mytoken: "SECRET8",
    };
    expect(redact(input)).toEqual({
      accesstoken: "[redacted]",
      authtoken: "[redacted]",
      sessiontoken: "[redacted]",
      csrftoken: "[redacted]",
      bearertoken: "[redacted]",
      usertoken: "[redacted]",
      clienttoken: "[redacted]",
      mytoken: "[redacted]",
    });
  });

  it("exempts only the explicit count-shaped allowlist, camelCase and snake_case", () => {
    expect(
      redact({
        tokensIn: 1,
        tokensOut: 2,
        tokenCount: 3,
        tokensUsed: 4,
        tokensTotal: 5,
        tokens_in: 1,
        tokens_out: 2,
        token_count: 3,
        tokens_used: 4,
        tokens_total: 5,
      }),
    ).toEqual({
      tokensIn: 1,
      tokensOut: 2,
      tokenCount: 3,
      tokensUsed: 4,
      tokensTotal: 5,
      tokens_in: 1,
      tokens_out: 2,
      token_count: 3,
      tokens_used: 4,
      tokens_total: 5,
    });
  });

  it("still redacts sessionToken, apiToken, accessToken, refresh_token, and a bare token", () => {
    expect(
      redact({ sessionToken: "a", apiToken: "b", accessToken: "c", refresh_token: "d", token: "e" }),
    ).toEqual({
      sessionToken: "[redacted]",
      apiToken: "[redacted]",
      accessToken: "[redacted]",
      refresh_token: "[redacted]",
      token: "[redacted]",
    });
  });

  it("redacts an array under a plural token field name that isn't on the allowlist", () => {
    expect(redact({ apiTokens: ["a", "b"] })).toEqual({ apiTokens: "[redacted]" });
  });

  it("redacts by default a token-shaped name nobody anticipated, rather than letting it survive", () => {
    expect(redact({ webhookToken: "x", sometokenvalue: "y" })).toEqual({
      webhookToken: "[redacted]",
      sometokenvalue: "[redacted]",
    });
  });

  // Credential vault (0036_vault_secret.sql, packages/vault): none of
  // "plaintext", "dataKey"/"data_key", "kek"/"kekId" or "ciphertext"
  // matched SENSITIVE_KEY before this task -- a struct like
  // sealSecret()'s SealedSecret, or a raw vault_secret row, accidentally
  // reaching a log call would have leaked unredacted.
  it("redacts a plaintext secret field, however it is named", () => {
    expect(redact({ plaintext: "top-secret-value" })).toEqual({ plaintext: "[redacted]" });
    expect(redact({ plaintextSecret: "top-secret-value" })).toEqual({ plaintextSecret: "[redacted]" });
  });

  it("redacts a data key field, camelCase or snake_case", () => {
    expect(redact({ dataKey: Buffer.from("k").toString("hex") })).toEqual({ dataKey: "[redacted]" });
    expect(redact({ data_key: "abc" })).toEqual({ data_key: "[redacted]" });
    expect(redact({ plaintextDataKey: "abc" })).toEqual({ plaintextDataKey: "[redacted]" });
  });

  it("redacts a key-encryption-key (KEK) field, including its id/version label", () => {
    expect(redact({ kek: "abc" })).toEqual({ kek: "[redacted]" });
    expect(redact({ kekId: "v1" })).toEqual({ kekId: "[redacted]" });
    expect(redact({ kek_id: "v1" })).toEqual({ kek_id: "[redacted]" });
  });

  it("redacts ciphertext-shaped fields defensively, even though ciphertext alone is not the secret", () => {
    expect(redact({ ciphertext: "deadbeef" })).toEqual({ ciphertext: "[redacted]" });
    expect(redact({ wrappedDataKey: "deadbeef" })).toEqual({ wrappedDataKey: "[redacted]" });
    expect(redact({ wrapped_data_key: "deadbeef" })).toEqual({ wrapped_data_key: "[redacted]" });
  });

  it("redacts a whole sealed-secret-shaped object at any depth", () => {
    const input = {
      workspaceId: "019ff775-f7f6-7e31-9114-45c0fb0e8fd2",
      sealed: {
        ciphertext: "deadbeef",
        iv: "aa",
        authTag: "bb",
        wrappedKey: { kekId: "v1", ciphertext: "cc", iv: "dd", authTag: "ee" },
      },
    };
    const out = redact(input) as typeof input;
    expect(out.workspaceId).toBe("019ff775-f7f6-7e31-9114-45c0fb0e8fd2");
    expect(out.sealed.ciphertext).toBe("[redacted]");
    expect(out.sealed.wrappedKey.kekId).toBe("[redacted]");
    expect(out.sealed.wrappedKey.ciphertext).toBe("[redacted]");
  });
});
