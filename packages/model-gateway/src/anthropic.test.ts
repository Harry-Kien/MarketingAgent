import { describe, expect, it } from "vitest";
import { createAnthropicProvider, type AnthropicProviderConfig, type FetchLike } from "./anthropic.ts";

const cfg: AnthropicProviderConfig = {
  apiKey: "fake-api-key-not-real",
  model: "claude-opus-5",
  maxOutputTokens: 1000,
  inputUsdPerMTok: 3,
  outputUsdPerMTok: 15,
};

function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

describe("createAnthropicProvider", () => {
  it("computes costUsd from the real token usage times the configured per-MTok prices", async () => {
    const { fetchImpl } = fakeFetch({
      content: [{ type: "text", text: "Xin chao!" }],
      model: "claude-opus-5-20260101",
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    const provider = createAnthropicProvider(cfg, fetchImpl);

    const result = await provider.generate({
      system: "You are a helpful assistant.",
      input: "Xin chao",
      schemaName: "greeting",
      maxOutputTokens: 500,
    });

    expect(result.tokensIn).toBe(1000);
    expect(result.tokensOut).toBe(500);
    // (1000 * 3 + 500 * 15) / 1_000_000
    expect(result.costUsd).toBeCloseTo(0.0105, 10);
    expect(result.text).toBe("Xin chao!");
    expect(result.modelVersion).toBe("claude-opus-5-20260101");
  });

  it("never touches the real network -- the injected fetch is the only HTTP path exercised", async () => {
    const { fetchImpl, calls } = fakeFetch({
      content: [{ type: "text", text: "ok" }],
      model: "claude-opus-5",
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const provider = createAnthropicProvider(cfg, fetchImpl);
    await provider.generate({ system: "s", input: "i", schemaName: "x", maxOutputTokens: 100 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("honours the caller's maxOutputTokens when it is below the configured ceiling", async () => {
    const { fetchImpl, calls } = fakeFetch({
      content: [{ type: "text", text: "ok" }],
      model: "claude-opus-5",
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    const provider = createAnthropicProvider(cfg, fetchImpl);
    await provider.generate({ system: "s", input: "i", schemaName: "x", maxOutputTokens: 200 });
    const sentBody = JSON.parse(calls[0]!.init!.body as string);
    expect(sentBody.max_tokens).toBe(200);
  });

  it("clamps to the configured maxOutputTokens ceiling when the caller asks for more", async () => {
    const { fetchImpl, calls } = fakeFetch({
      content: [{ type: "text", text: "ok" }],
      model: "claude-opus-5",
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    const provider = createAnthropicProvider(cfg, fetchImpl); // cfg.maxOutputTokens = 1000
    await provider.generate({ system: "s", input: "i", schemaName: "x", maxOutputTokens: 5000 });
    const sentBody = JSON.parse(calls[0]!.init!.body as string);
    expect(sentBody.max_tokens).toBe(1000);
  });

  it("throws instead of fabricating a cost when the response carries no usable usage", async () => {
    const { fetchImpl } = fakeFetch({
      content: [{ type: "text", text: "ok" }],
      model: "claude-opus-5",
      usage: {},
    });
    const provider = createAnthropicProvider(cfg, fetchImpl);
    await expect(
      provider.generate({ system: "s", input: "i", schemaName: "x", maxOutputTokens: 100 }),
    ).rejects.toThrow(/usage/);
  });

  it("throws a descriptive error on a non-2xx response instead of returning a fake result", async () => {
    const { fetchImpl } = fakeFetch(
      { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
      401,
    );
    const provider = createAnthropicProvider(cfg, fetchImpl);
    await expect(
      provider.generate({ system: "s", input: "i", schemaName: "x", maxOutputTokens: 100 }),
    ).rejects.toThrow(/invalid x-api-key/);
  });

  // Adversarial hardening beyond the brief: a plain `Number.isFinite` check
  // does NOT reject negative numbers (Number.isFinite(-1000000) === true),
  // so a hostile or buggy upstream that reports a negative token count would
  // otherwise sail through and produce a negative costUsd -- which would
  // silently "refund" the gateway's spend ledger (gateway.ts's
  // isRecordableCost only accepts costUsd >= 0, but by the time that guard
  // fires the caller only sees an opaque "invalid cost" error with no clue
  // it came from a negative token count). The provider must refuse at the
  // source with a message that still mentions usage/tokens.
  it("throws instead of fabricating a cost when the response carries a negative token count", async () => {
    const { fetchImpl } = fakeFetch({
      content: [{ type: "text", text: "ok" }],
      model: "claude-opus-5",
      usage: { input_tokens: -5, output_tokens: 10 },
    });
    const provider = createAnthropicProvider(cfg, fetchImpl);
    await expect(
      provider.generate({ system: "s", input: "i", schemaName: "x", maxOutputTokens: 100 }),
    ).rejects.toThrow(/usage/);
  });

  // A response whose `stop_reason` is "refusal" still bills real tokens (the
  // model read the input and produced a refusal message) -- the provider
  // must still report the true cost rather than treating a refusal as
  // free. This proves refusal responses aren't special-cased into a $0 cost.
  it("still reports the true billed cost when the model refuses to answer", async () => {
    const { fetchImpl } = fakeFetch({
      content: [{ type: "text", text: "I can't help with that." }],
      model: "claude-opus-5",
      stop_reason: "refusal",
      usage: { input_tokens: 200, output_tokens: 8 },
    });
    const provider = createAnthropicProvider(cfg, fetchImpl);
    const result = await provider.generate({ system: "s", input: "i", schemaName: "x", maxOutputTokens: 100 });
    expect(result.tokensIn).toBe(200);
    expect(result.tokensOut).toBe(8);
    // (200 * 3 + 8 * 15) / 1_000_000
    expect(result.costUsd).toBeCloseTo(0.00072, 10);
  });

  // A non-2xx response can still carry a partial/malformed body (truncated
  // mid-stream, proxy error page, etc.) -- JSON.parse itself throws, and the
  // provider must surface a descriptive error rather than crash with an
  // unhandled SyntaxError or, worse, fall through to inventing a result.
  it("throws a descriptive error on a non-2xx response with a non-JSON body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });
    };
    const provider = createAnthropicProvider(cfg, fetchImpl);
    await expect(
      provider.generate({ system: "s", input: "i", schemaName: "x", maxOutputTokens: 100 }),
    ).rejects.toThrow(/502/);
  });
});
