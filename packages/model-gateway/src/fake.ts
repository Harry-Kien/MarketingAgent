import type { GenerateRequest, GenerateResult, ModelProvider } from "./types.ts";

/**
 * Deterministic by construction: reads no clock, generates no random
 * numbers, reads no environment variables, and makes no network call.
 * Every P2 test runs against this provider so that no test or CI run ever
 * calls a paid model (STANDING-CONTEXT R1).
 *
 * `generate` is a pure function of its arguments: same `script` + same
 * `req` always yields the same `GenerateResult`, forever, from any provider
 * instance built from an equal script.
 *
 * The `script` is frozen at construction. A caller who mutates the object
 * they passed in gets an immediate `TypeError` (ES modules run in strict
 * mode) rather than a provider whose answers silently drift after
 * construction -- a loud failure beats a quiet surprise later. Freezing
 * also means the provider never needs to defensively copy the script.
 *
 * An unscripted `schemaName` throws instead of returning a plausible
 * fallback, so a test can never accidentally pass against a response
 * nobody wrote.
 */
export function createFakeProvider(script: Record<string, string>): ModelProvider {
  Object.freeze(script);

  return {
    name: "fake",
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const text = script[req.schemaName];
      if (text === undefined) {
        throw new Error(`No scripted response for schema "${req.schemaName}"`);
      }
      return {
        text,
        tokensIn: req.system.length + req.input.length,
        tokensOut: text.length,
        costUsd: 0,
        modelVersion: "fake-1",
      };
    },
  };
}
