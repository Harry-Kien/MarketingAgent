// T7: the agent runtime -- dispatch, checkpoint, activation gate. Composes
// P1's assertActivated (packages/domain/src/agent-registry.ts), T2's Gateway
// (packages/model-gateway/src/gateway.ts -- budget enforcement with a
// high-water-mark reservation), T4's ToolRegistry (this package's tools.ts)
// and T5's parseAgentOutput boundary (packages/contracts/src/agent-output.ts,
// consumed here only through the caller-supplied `parse` callback -- this
// file never imports @smos/contracts directly, so it stays agnostic to which
// schema a given role uses).
//
// Two properties beyond task-7-brief.md's reference implementation, both
// required by this task's brief:
//
// (1) RunStore.finishRun's patch carries an optional `output` field, present
// only on the success path and only ever set to whatever `parse()` returned
// -- never the raw model text, and never anything on a failure path. This is
// runtime.ts's whole contribution to "persist the validated output durably,
// in the same transaction as the terminal state": it hands the store the
// value and the moment; the store (packages/db/src/repositories/run-store.ts)
// is what actually makes that one database transaction.
//
// (2) The activation gate (assertActivated) runs before store.createRun is
// ever called, so a non-activated role costs nothing and leaves no
// AgentRun -- but that is a TypeScript-level gate only. The database itself
// also refuses (0025_agent_run_activation_gate.sql), so a direct SQL insert
// as smos_app for a non-activated agent is refused independently of this
// file ever running at all.
import { assertActivated, type AgentRegistryEntry, type AgentRole, type Id } from "@smos/domain";
import type { Gateway } from "@smos/model-gateway";
import { logger } from "@smos/telemetry";
import type { ToolRegistry } from "./tools.ts";

export interface RunStore {
  createRun(r: { workspaceId: Id; agentVersionId: Id; campaignId: Id; correlationId: Id }): Promise<Id>;
  checkpoint(runId: Id, step: string, blob: Record<string, unknown>): Promise<void>;
  finishRun(
    runId: Id,
    patch: {
      state: string;
      costUsd: number;
      budgetExceeded: boolean;
      errorCode?: string;
      /**
       * Set only on the success path, only to the value `parse()` returned
       * (i.e. output that has already passed the caller's schema boundary --
       * see task-7-report.md requirement 1). Absent on every failure path:
       * a run that never produced validated output must never carry one.
       */
      output?: unknown;
    },
  ): Promise<void>;
}

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

  let budgetExceeded = false;
  try {
    const prompt = input.buildPrompt();
    await input.store.checkpoint(runId, "prompt_built", { schemaName: prompt.schemaName });

    const result = await input.gateway.generate(
      { ...prompt, maxOutputTokens: 4096 },
      { workspaceId: input.workspaceId, agentRunId: runId },
    );
    await input.store.checkpoint(runId, "model_returned", { tokensOut: result.tokensOut });

    // input.parse is the T5 boundary (parseAgentOutput bound to a role's
    // schema, for every real caller): it throws on anything that is not
    // valid JSON matching the closed schema, so `output` below is reached
    // only once that has already succeeded -- there is no path from here to
    // finishRun that carries `result.text` (the raw model string) itself.
    const output = input.parse(result.text);
    await input.store.checkpoint(runId, "output_parsed", {});

    await input.store.finishRun(runId, {
      state: "succeeded",
      costUsd: input.gateway.spentUsd(),
      budgetExceeded: false,
      output,
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
    });
    throw error;
  }
}
