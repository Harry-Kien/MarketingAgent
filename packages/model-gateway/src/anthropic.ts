import type { GenerateRequest, GenerateResult, ModelProvider } from "./types.ts";

export interface AnthropicProviderConfig {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

/** The subset of `fetch`'s signature this module depends on -- narrow on
 * purpose so a test's fake fetch doesn't need to implement anything beyond
 * what is actually used. Mirrors
 * packages/integrations/src/guarded-fetch.ts's FetchLike, redeclared here
 * (not imported) so packages/model-gateway does not take a dependency on
 * packages/integrations for one type alias. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Computes costUsd itself from the token counts the API actually billed,
 * times the caller-configured per-MTok prices -- never guessed, never a
 * flat per-call estimate. gateway.ts trusts this number outright to
 * enforce its budget (see that file's header on estimatedCostUsd being a
 * declared per-call MAXIMUM): a wrong computation here is a money bug.
 */
function computeCostUsd(tokensIn: number, tokensOut: number, cfg: AnthropicProviderConfig): number {
  return (tokensIn * cfg.inputUsdPerMTok + tokensOut * cfg.outputUsdPerMTok) / 1_000_000;
}

/**
 * A token count is usable only if it is a real, non-negative, finite
 * number. `Number.isFinite` alone is NOT enough: `Number.isFinite(-5)` is
 * `true`, so a hostile or buggy upstream reporting a negative token count
 * would otherwise sail through `computeCostUsd` and produce a negative
 * costUsd -- which would silently "refund" the gateway's running spend
 * total (gateway.ts's `isRecordableCost` only accepts `costUsd >= 0`, so a
 * negative cost is eventually caught there too, but only as an opaque
 * "invalid cost" error with no trace back to the negative token count that
 * caused it). Refusing here, at the source, keeps the failure legible.
 */
function isUsableTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function extractErrorMessage(parsed: unknown, status: number): string {
  if (
    parsed &&
    typeof parsed === "object" &&
    "error" in parsed &&
    parsed.error &&
    typeof (parsed as { error: { message?: unknown } }).error.message === "string"
  ) {
    return (parsed as { error: { message: string } }).error.message;
  }
  return `HTTP ${status}`;
}

/**
 * `fetchImpl` defaults to the real global `fetch`, exactly like
 * `guardedFetch` and `createMetaAdapter` elsewhere in this codebase -- it
 * exists purely so a test can swap in a fake HTTP response, never so a
 * real caller has to think about it. Every test for this provider drives
 * it through a fake fetchImpl that never opens a socket (Global Constraint:
 * no paid model call in any test, ever).
 */
export function createAnthropicProvider(cfg: AnthropicProviderConfig, fetchImpl: FetchLike = fetch): ModelProvider {
  return {
    name: "anthropic",

    async generate(req: GenerateRequest): Promise<GenerateResult> {
      // maxOutputTokens on the config is a hard per-call ceiling (interface
      // contract): a caller may ask for less, never more.
      const maxTokens = Math.min(req.maxOutputTokens, cfg.maxOutputTokens);

      const response = await fetchImpl(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "x-api-key": cfg.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: maxTokens,
          system: req.system,
          messages: [{ role: "user", content: req.input }],
        }),
      });

      const bodyText = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        throw new Error(
          `Anthropic provider "${cfg.model}": non-JSON response (status ${response.status}): ${bodyText.slice(0, 200)}`,
        );
      }

      if (!response.ok) {
        throw new Error(`Anthropic provider "${cfg.model}" request failed: ${extractErrorMessage(parsed, response.status)}`);
      }

      const data = parsed as AnthropicMessagesResponse;
      const tokensIn = data.usage?.input_tokens;
      const tokensOut = data.usage?.output_tokens;

      // A hostile or buggy upstream must not be able to make this provider
      // invent a cost: if the token counts we would multiply by price are
      // not real, non-negative, finite numbers, refuse outright rather than
      // returning costUsd: 0, NaN, or (via a negative token count) a
      // negative number (gateway.ts's isRecordableCost would otherwise
      // silently record nothing for real money spent, or let a negative
      // value corrupt the running total in the wrong direction).
      if (!isUsableTokenCount(tokensIn) || !isUsableTokenCount(tokensOut)) {
        throw new Error(
          `Anthropic provider "${cfg.model}": response carried no usable token usage -- refusing to invent a cost. Got usage: ${JSON.stringify(data.usage)}`,
        );
      }

      const text = (data.content ?? [])
        .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");

      return {
        text,
        tokensIn,
        tokensOut,
        costUsd: computeCostUsd(tokensIn, tokensOut, cfg),
        modelVersion: data.model ?? cfg.model,
      };
    },
  };
}
