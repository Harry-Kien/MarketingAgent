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
  recordToolCall: vi.fn(async () => undefined),
});

const base = (
  role: (typeof ALL_AGENT_ROLES)[number],
  provider = createFakeProvider({ "s.v1": '{"ok":true}' }),
) => ({
  role,
  registry,
  gateway: createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.05 }),
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
        gateway: createGateway({ provider: provider as never, budgetUsd: 1, maxWallclockMs: 100, estimatedCostUsd: 0.05 }),
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
      gateway: createGateway({ provider: costly, budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.05 }),
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
  //
  // Fix round 1, CRITICAL follow-up: the reviewer found that the original
  // version of this test asserted only `succeeded === 1 && spentUsd <= 1` --
  // which stays true even on the pre-fix gateway, where BOTH concurrent
  // calls reach the real provider (only one is later counted as "spent").
  // "One run survived" is not the same claim as "the provider was invoked
  // at most once" -- the latter is what actually controls real vendor
  // spend, so it is what this test now asserts on directly, via a call
  // counter on the provider itself, exactly like gateway.test.ts's own
  // cold-burst tests.
  it("racing two runAgent calls against one shared budget: the provider is invoked at most once, not just 'one run survives'", async () => {
    let providerCalls = 0;
    const gateway = createGateway({
      provider: {
        name: "racer",
        generate: async () => {
          providerCalls++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { text: '{"ok":true}', tokensIn: 1, tokensOut: 1, costUsd: 0.7, modelVersion: "m" };
        },
      },
      budgetUsd: 1,
      maxWallclockMs: 5000,
      // Matches the real per-call cost: at $0.7/call and a $1 budget, only
      // one call can ever be afforded, on a gateway that has never made a
      // call before (cold -- no warm-up call precedes the race below).
      estimatedCostUsd: 0.7,
    });
    const run = (s: ReturnType<typeof store>) => runAgent({ ...base("research"), gateway, store: s });

    const results = await Promise.allSettled([run(store()), run(store())]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(String((failed[0] as PromiseRejectedResult).reason)).toMatch(/budget/i);
    expect(gateway.spentUsd()).toBeLessThanOrEqual(1);
    // The property that actually matters: real vendor spend never happens
    // twice, not merely "the ledger only counted it once".
    expect(providerCalls).toBe(1);
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

// Fix round 1, IMPORTANT: "the tool registry is never wired into the
// runtime." Coordinator ruled this in scope for T7. `runAgent` now accepts
// an optional `interpretToolCall(raw): { name; args } | null` -- omitted
// (as every test above does), the loop behaves exactly as before: one
// generate() call, then straight to `parse()`. When supplied and it
// returns non-null, runAgent routes the request through `input.tools`
// (T4's registry -- the construction-time allowlist snapshot still
// governs), records every attempt via `store.recordToolCall` (T6's
// tool_call table, "whether the tool registry allowed it or refused it"
// per 0024's own comment), and -- only for an ALLOWED call -- wraps the
// result with T3's wrapUntrusted before feeding it back into the next
// prompt's `input`, never as an instruction.
describe("runAgent tool dispatch (fix round 1, IMPORTANT)", () => {
  it("refuses a tool that is not on the role's allowlist -- through runAgent, not by calling tools.invoke directly", async () => {
    const s = store();
    const publish = vi.fn();
    const tools = createToolRegistry([{ name: "publish.meta", handler: publish }]);
    // "content" registered here with an EMPTY toolAllowlist -- the model
    // asks for "publish.meta" anyway (interpretToolCall always returns it),
    // exactly the prompt-injection shape T3/T11 exist to make harmless.
    const registryNoTools = ALL_AGENT_ROLES.map((role) => ({
      role,
      versionId: newId(),
      activated: (M1_ACTIVATED_AGENTS as readonly string[]).includes(role),
      toolAllowlist: [] as string[],
      prohibitedActions: [],
    }));
    const input = {
      ...base("content"),
      registry: registryNoTools,
      tools,
      interpretToolCall: () => ({ name: "publish.meta", args: {} }),
      store: s,
    };

    await expect(runAgent(input)).rejects.toThrow(/not on the tool allowlist/i);
    // The refusal happened at the registry (T4), not by runAgent silently
    // skipping the call -- the handler itself must never run.
    expect(publish).not.toHaveBeenCalled();
    // The audit trail records the refused attempt (T6: "whether the tool
    // registry allowed it or refused it").
    expect(s.recordToolCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "publish.meta", allowed: false }),
    );
    expect(s.finishRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: "failed_terminal" }));
  });

  it("invokes an allowlisted tool, records it, wraps its result as untrusted data, and continues to a final parsed output", async () => {
    const s = store();
    const handler = vi.fn(async () => ({ found: "brand voice: bold" }));
    const tools = createToolRegistry([{ name: "read.brand", handler }]);
    const registryWithTool = ALL_AGENT_ROLES.map((role) => ({
      role,
      versionId: newId(),
      activated: (M1_ACTIVATED_AGENTS as readonly string[]).includes(role),
      toolAllowlist: role === "content" ? ["read.brand"] : [],
      prohibitedActions: [],
    }));

    let calls = 0;
    const seenInputs: string[] = [];
    const provider = {
      name: "scripted",
      generate: async (req: { input: string }) => {
        calls++;
        seenInputs.push(req.input);
        // Round 1: ask for the tool. Round 2 (after the tool result is fed
        // back): return the final output.
        const text = calls === 1 ? JSON.stringify({ toolCall: true }) : JSON.stringify({ ok: true });
        return { text, tokensIn: 1, tokensOut: 1, costUsd: 0, modelVersion: "m" };
      },
    };

    const input = {
      role: "content" as const,
      registry: registryWithTool,
      gateway: createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.05 }),
      tools,
      workspaceId: newId(),
      campaignId: newId(),
      correlationId: newId(),
      buildPrompt: () => ({ system: "s", input: "i", schemaName: "s.v1" }),
      parse: (raw: string) => JSON.parse(raw),
      interpretToolCall: (raw: string) => {
        const parsed = JSON.parse(raw) as { toolCall?: boolean };
        return parsed.toolCall ? { name: "read.brand", args: { topic: "voice" } } : null;
      },
      store: s,
    };

    const r = await runAgent(input);
    expect(r.output).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ topic: "voice" }, expect.objectContaining({ workspaceId: input.workspaceId }));
    expect(s.recordToolCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "read.brand", allowed: true }),
    );
    // The tool's result reached the SECOND prompt only wrapped as untrusted
    // data (T3's boundary tag), never as a bare instruction-shaped string.
    expect(seenInputs[1]).toContain("untrusted_content");
    expect(seenInputs[1]).toContain("brand voice: bold");
  });

  it("bounds the tool-call loop so a model that never stops asking for a tool cannot spin forever", async () => {
    const s = store();
    const handler = vi.fn(async () => ({ more: true }));
    const tools = createToolRegistry([{ name: "read.brand", handler }]);
    const registryWithTool = ALL_AGENT_ROLES.map((role) => ({
      role,
      versionId: newId(),
      activated: (M1_ACTIVATED_AGENTS as readonly string[]).includes(role),
      toolAllowlist: role === "content" ? ["read.brand"] : [],
      prohibitedActions: [],
    }));
    const provider = {
      name: "infinite",
      generate: async () => ({ text: JSON.stringify({ toolCall: true }), tokensIn: 1, tokensOut: 1, costUsd: 0, modelVersion: "m" }),
    };
    const input = {
      role: "content" as const,
      registry: registryWithTool,
      gateway: createGateway({ provider, budgetUsd: 100, maxWallclockMs: 5000, estimatedCostUsd: 0.01 }),
      tools,
      workspaceId: newId(),
      campaignId: newId(),
      correlationId: newId(),
      buildPrompt: () => ({ system: "s", input: "i", schemaName: "s.v1" }),
      parse: (raw: string) => JSON.parse(raw),
      interpretToolCall: () => ({ name: "read.brand", args: {} }),
      store: s,
    };

    await expect(runAgent(input)).rejects.toThrow(/tool call/i);
    // Finite: the model asked for a tool every single round, forever, and
    // the run still terminated with a bounded number of actual tool
    // invocations rather than hanging.
    expect(handler.mock.calls.length).toBeGreaterThan(0);
    expect(handler.mock.calls.length).toBeLessThan(1000);
  });
});
