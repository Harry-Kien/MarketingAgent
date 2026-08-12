// T7: the agent runtime -- dispatch, checkpoint, activation gate. Per
// task-7-brief.md, largely verbatim, plus two closures the task's own review
// flagged as missing from the brief:
//
// (1) Persisted output. run_checkpoint.state_blob is the only jsonb column
// T6 gave the runtime; RunStore.finishRun's patch is extended here with an
// optional `output` field so a real (Postgres-backed) store can write the
// validated output in the SAME transaction as the terminal state update.
// This file proves runtime.ts's own contribution to that: `output` is
// forwarded to finishRun only on the success path (never on a parse
// failure, never the raw model text) -- see "persists only validated
// output" below. The actual atomic-transaction proof lives in
// packages/db/src/repositories/run-store.test.ts, against real Postgres.
//
// (2) The database-level activation gate (0025_agent_run_activation_gate.sql)
// is proved in packages/db/src/agent-run-activation-gate.test.ts, not here --
// this file only proves the TypeScript-level gate (assertActivated) that
// runs before anything is recorded.
import { describe, expect, it, vi } from "vitest";
import { runAgent } from "./runtime.ts";
import { createToolRegistry } from "./tools.ts";
import { createGateway, createFakeProvider } from "@smos/model-gateway";
import { ALL_AGENT_ROLES, M1_ACTIVATED_AGENTS, newId, AgentNotActivatedError } from "@smos/domain";
import { parseAgentOutput, researchOutputSchema } from "@smos/contracts";

const registry = ALL_AGENT_ROLES.map((role) => ({
  role,
  versionId: newId(),
  activated: (M1_ACTIVATED_AGENTS as readonly string[]).includes(role),
  toolAllowlist: [],
  prohibitedActions: [],
}));

const store = () => ({
  createRun: vi.fn(async () => newId()),
  checkpoint: vi.fn(async () => undefined),
  finishRun: vi.fn(async () => undefined),
});

const base = (
  role: (typeof ALL_AGENT_ROLES)[number],
  provider = createFakeProvider({ "s.v1": '{"ok":true}' }),
) => ({
  role,
  registry,
  gateway: createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000 }),
  tools: createToolRegistry([]),
  workspaceId: newId(),
  campaignId: newId(),
  correlationId: newId(),
  buildPrompt: () => ({ system: "s", input: "i", schemaName: "s.v1" }),
  parse: (raw: string) => JSON.parse(raw),
});

describe("runAgent activation gate", () => {
  it("refuses a non-activated role and never calls the provider", async () => {
    const provider = { name: "spy", generate: vi.fn() };
    const s = store();
    await expect(
      runAgent({
        ...base("paid_media_advisor"),
        gateway: createGateway({ provider: provider as never, budgetUsd: 1, maxWallclockMs: 100 }),
        store: s,
      }),
    ).rejects.toThrow(AgentNotActivatedError);
    expect(provider.generate).not.toHaveBeenCalled();
    expect(s.createRun).not.toHaveBeenCalled();
  });

  it("runs an activated role", async () => {
    const s = store();
    const r = await runAgent({ ...base("content"), store: s });
    expect(r.output).toEqual({ ok: true });
    expect(s.createRun).toHaveBeenCalledOnce();
    expect(s.finishRun).toHaveBeenCalledWith(r.runId, expect.objectContaining({ state: "succeeded" }));
  });
});

describe("runAgent bookkeeping", () => {
  it("checkpoints before and after the model call", async () => {
    const s = store();
    await runAgent({ ...base("research"), store: s });
    const steps = s.checkpoint.mock.calls.map((c) => c[1]);
    expect(steps).toEqual(["prompt_built", "model_returned", "output_parsed"]);
  });

  it("marks the run failed_terminal when parsing fails", async () => {
    const s = store();
    const input = { ...base("content", createFakeProvider({ "s.v1": "not json" })), store: s };
    await expect(runAgent({ ...input, parse: (raw) => JSON.parse(raw) })).rejects.toThrow();
    expect(s.finishRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: "failed_terminal" }));
  });

  it("marks budget_exceeded when the gateway refuses", async () => {
    const s = store();
    const costly = {
      name: "c",
      generate: async () => ({ text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 5, modelVersion: "m" }),
    };
    const input = {
      ...base("qa_brand_safety"),
      gateway: createGateway({ provider: costly, budgetUsd: 1, maxWallclockMs: 5000 }),
      store: s,
    };
    await expect(runAgent(input)).rejects.toThrow(/budget/i);
    expect(s.finishRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ budgetExceeded: true }));
  });

  // Adversarial check (self-review, "exceed the budget by racing two runs"):
  // T2's high-water-mark reservation (packages/model-gateway/src/gateway.ts)
  // is proved directly against Gateway in gateway.test.ts. This proves the
  // SAME protection survives being driven through runAgent -- two concurrent
  // runs sharing one Gateway instance, each costing more than half the
  // budget, must never both succeed.
  it("racing two runAgent calls against one shared budget: at most one succeeds, spend never exceeds budget", async () => {
    const gateway = createGateway({
      provider: {
        name: "racer",
        generate: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { text: '{"ok":true}', tokensIn: 1, tokensOut: 1, costUsd: 0.7, modelVersion: "m" };
        },
      },
      budgetUsd: 1,
      maxWallclockMs: 5000,
    });
    const run = (s: ReturnType<typeof store>) => runAgent({ ...base("research"), gateway, store: s });

    const results = await Promise.allSettled([run(store()), run(store())]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(String((failed[0] as PromiseRejectedResult).reason)).toMatch(/budget/i);
    expect(gateway.spentUsd()).toBeLessThanOrEqual(1);
  });
});

// Hard requirement (1): "persist the validated output durably... within the
// same transaction that records the run's terminal state... Persist only
// output that has already passed parseAgentOutput -- never the raw model
// text." runtime.ts cannot itself open a database transaction (it only
// holds a RunStore), so its share of that requirement is: forward exactly
// what `parse()` returned -- and nothing else -- to finishRun on success,
// and never forward anything on failure. The real store
// (packages/db/src/repositories/run-store.ts) is what turns "forwarded on
// the same call" into "written in the same transaction".
describe("runAgent output forwarding to finishRun (requirement 1)", () => {
  it("forwards the parsed, schema-validated output to finishRun on success", async () => {
    const s = store();
    const citation = { url: "https://example.test/a", accessedAt: new Date().toISOString(), excerpt: "e" };
    const validOutput = { findings: [{ claim: "c", verificationStatus: "VERIFIED", citations: [citation] }] };
    const raw = JSON.stringify(validOutput);
    const input = {
      ...base("research", createFakeProvider({ "s.v1": raw })),
      store: s,
      parse: (text: string) => parseAgentOutput(researchOutputSchema, text),
    };
    const r = await runAgent(input);
    expect(r.output).toEqual(validOutput);
    expect(s.finishRun).toHaveBeenCalledWith(
      r.runId,
      expect.objectContaining({ state: "succeeded", output: validOutput }),
    );
  });

  it("never forwards raw text, and never calls finishRun with an output field, when parseAgentOutput throws", async () => {
    const s = store();
    const input = {
      ...base("content", createFakeProvider({ "s.v1": "not json at all" })),
      store: s,
      parse: (text: string) => parseAgentOutput(researchOutputSchema, text),
    };
    await expect(runAgent(input)).rejects.toThrow();
    expect(s.finishRun).toHaveBeenCalledOnce();
    const patch = s.finishRun.mock.calls[0][1] as Record<string, unknown>;
    expect(patch.state).toBe("failed_terminal");
    expect(patch).not.toHaveProperty("output");
  });
});
