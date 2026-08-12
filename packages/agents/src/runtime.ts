// T7: the agent runtime -- dispatch, checkpoint, activation gate. Composes
// P1's assertActivated (packages/domain/src/agent-registry.ts), T2's Gateway
// (packages/model-gateway/src/gateway.ts -- budget enforcement with a
// high-water-mark reservation), T4's ToolRegistry (this package's tools.ts),
// T3's wrapUntrusted (this package's untrusted.ts) and T5's parseAgentOutput
// boundary (packages/contracts/src/agent-output.ts, consumed here only
// through the caller-supplied `parse` callback -- this file never imports
// @smos/contracts directly, so it stays agnostic to which schema a given
// role uses).
//
// RunStore is imported from @smos/db, not redeclared here (fix round 1,
// MINOR: the original version of this file kept its own structural copy of
// the interface, free to drift from packages/db/src/repositories/run-store.ts's
// real implementation -- there is now exactly one definition).
//
// Beyond task-7-brief.md's reference implementation:
//
// (1) RunStore.finishRun's patch carries an optional `output` field, present
// only on the success path and only ever set to whatever `parse()` returned
// -- never the raw model text, and never anything on a failure path. This is
// runtime.ts's whole contribution to "persist the validated output durably,
// in the same transaction as the terminal state": it hands the store the
// value and the moment; the store is what actually makes that one database
// transaction.
//
// (2) The activation gate (assertActivated) runs before store.createRun is
// ever called, so a non-activated role costs nothing and leaves no
// AgentRun -- but that is a TypeScript-level gate only. The database itself
// also refuses (0025_agent_run_activation_gate.sql), so a direct SQL insert
// as smos_app for a non-activated agent is refused independently of this
// file ever running at all.
//
// (3) Fix round 1, IMPORTANT: tool dispatch. `interpretToolCall` is an
// optional caller-supplied hook -- omitted, the loop behaves exactly as
// before (one generate() call, straight to `parse()`); every existing
// caller in this package's tests is unaffected. When supplied and it
// returns a request, the request is routed through `input.tools` (T4's
// registry -- the construction-time allowlist snapshot governs, never this
// file's own judgment), every attempt is recorded via
// `store.recordToolCall` regardless of whether it was allowed, and only an
// ALLOWED tool's result is fed back into the next round's prompt -- always
// through `wrapUntrusted` (T3), so it can only ever be read as labelled
// data, never as an instruction. The loop is bounded
// (MAX_TOOL_CALLS_PER_RUN): a model that never stops asking for a tool
// still terminates the run instead of spinning forever.
import { assertActivated, type AgentRegistryEntry, type AgentRole, type Id } from "@smos/domain";
import type { Gateway } from "@smos/model-gateway";
import type { RunStore } from "@smos/db";
import { logger } from "@smos/telemetry";
import { wrapUntrusted } from "./untrusted.ts";
import type { ToolRegistry } from "./tools.ts";

export type { RunStore } from "@smos/db";

/** A model's request to call one tool, as decided by `interpretToolCall`. */
export interface ToolCallRequest {
  name: string;
  args: unknown;
}

/**
 * Hard ceiling on how many tool-call rounds a single run may make.
 * Deliberately generous (this bounds a loop, not a typical well-behaved
 * run) but finite: a model that asks for a tool on every single round
 * still terminates the run rather than running forever.
 */
export const MAX_TOOL_CALLS_PER_RUN = 8;

export interface RunAgentInput {
  role: AgentRole;
  registry: AgentRegistryEntry[];
  gateway: Gateway;
  tools: ToolRegistry;
  workspaceId: Id;
  campaignId: Id;
  correlationId: Id;
  buildPrompt(): { system: string; input: string; schemaName: string };
  parse(raw: string): unknown;
  /**
   * Optional. Given the raw text of a model response, decides whether it is
   * a request to call a tool (returns the request) or the run's final
   * answer (returns null). Omitted entirely by every caller that has no
   * tools to offer -- in which case the very first response is always
   * treated as final, exactly matching this function's pre-tool-dispatch
   * behaviour.
   */
  interpretToolCall?(raw: string): ToolCallRequest | null;
  store: RunStore;
}

export interface RunAgentResult {
  runId: Id;
  output: unknown;
  costUsd: number;
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  // The activation gate runs before anything is recorded or spent, so a
  // non-activated agent costs nothing and leaves no AgentRun (invariant 5).
  assertActivated(input.role, input.registry);
  const entry = input.registry.find((e) => e.role === input.role)!;

  const runId = await input.store.createRun({
    workspaceId: input.workspaceId,
    agentVersionId: entry.versionId,
    campaignId: input.campaignId,
    correlationId: input.correlationId,
  });

  const startedAtMs = Date.now();
  // Accumulated across every model call this run makes, including every
  // round of a tool-calling loop, and forwarded to finishRun on BOTH the
  // success and the failure path (fix round 1, MINOR) -- a run that fails
  // after spending real tokens must still record that it did, not reset to
  // the column's DEFAULT 0.
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let lastModelVersion: string | undefined;
  let budgetExceeded = false;

  try {
    let prompt = input.buildPrompt();
    await input.store.checkpoint(runId, "prompt_built", { schemaName: prompt.schemaName });

    let raw = "";
    for (let round = 0; ; round++) {
      const result = await input.gateway.generate(
        { ...prompt, maxOutputTokens: 4096 },
        { workspaceId: input.workspaceId, agentRunId: runId },
      );
      totalTokensIn += result.tokensIn;
      totalTokensOut += result.tokensOut;
      lastModelVersion = result.modelVersion;
      await input.store.checkpoint(
        runId,
        round === 0 ? "model_returned" : `model_returned_round_${round}`,
        { tokensOut: result.tokensOut },
      );
      raw = result.text;

      const toolCall = input.interpretToolCall?.(raw) ?? null;
      if (toolCall === null) break;

      if (round + 1 > MAX_TOOL_CALLS_PER_RUN) {
        throw new Error(
          `Agent run exceeded the maximum of ${MAX_TOOL_CALLS_PER_RUN} tool calls in a single run`,
        );
      }

      // The construction-time allowlist snapshot (T4) is the actual
      // enforcement layer -- this precomputed flag only decides what gets
      // recorded as `allowed`, it never grants an effect the registry
      // itself would refuse: `input.tools.invoke` below re-checks the same
      // allowlist independently and is what actually throws on a refusal.
      const allowed = entry.toolAllowlist.includes(toolCall.name);
      await input.store.recordToolCall(runId, { name: toolCall.name, allowed, args: toolCall.args });

      // T4's registry: refuses (and logs policy.violation) before the
      // handler ever runs if `toolCall.name` is not on ctx.allowlist.
      const toolResult = await input.tools.invoke(toolCall.name, toolCall.args, {
        workspaceId: input.workspaceId,
        agentRunId: runId,
        allowlist: entry.toolAllowlist,
      });

      // The tool's result is untrusted content exactly like anything a
      // Research agent might fetch off the open web (T3's own framing) --
      // wrapped with a fresh per-call nonce boundary before it ever
      // reaches the next prompt, so it can only be read as labelled DATA,
      // never as an instruction.
      const wrapped = wrapUntrusted(
        { url: `tool:${toolCall.name}`, accessedAt: new Date() },
        JSON.stringify(toolResult),
      );
      prompt = { ...prompt, input: `${prompt.input}\n${wrapped}` };
    }

    // input.parse is the T5 boundary (parseAgentOutput bound to a role's
    // schema, for every real caller): it throws on anything that is not
    // valid JSON matching the closed schema, so `output` below is reached
    // only once that has already succeeded -- there is no path from here to
    // finishRun that carries the raw model string itself.
    const output = input.parse(raw);
    await input.store.checkpoint(runId, "output_parsed", {});

    await input.store.finishRun(runId, {
      state: "succeeded",
      costUsd: input.gateway.spentUsd(),
      budgetExceeded: false,
      output,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      wallclockMs: Date.now() - startedAtMs,
      // exactOptionalPropertyTypes forbids `modelVersion: string | undefined`
      // against an optional `modelVersion?: string` -- spread it in only
      // when actually known, rather than passing an explicit undefined.
      ...(lastModelVersion !== undefined ? { modelVersion: lastModelVersion } : {}),
    });
    return { runId, output, costUsd: input.gateway.spentUsd() };
  } catch (error) {
    budgetExceeded = /budget/i.test(String(error));
    logger.error("agent run failed", {
      workspaceId: input.workspaceId,
      agentRunId: runId,
      role: input.role,
      error: String(error),
    });
    await input.store.finishRun(runId, {
      state: "failed_terminal",
      costUsd: input.gateway.spentUsd(),
      budgetExceeded,
      errorCode: budgetExceeded ? "BUDGET_EXCEEDED" : "RUN_FAILED",
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      wallclockMs: Date.now() - startedAtMs,
      ...(lastModelVersion !== undefined ? { modelVersion: lastModelVersion } : {}),
    });
    throw error;
  }
}
