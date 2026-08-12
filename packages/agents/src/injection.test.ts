// T11: prompt injection regression suite (E9). Per
// .superpowers/sdd/2026-08-11-p2-agent-runtime-approval/STANDING-CONTEXT.md,
// this attacks runAgent itself, not tools.invoke directly -- an earlier
// draft of this suite called the registry directly, which made its "never
// reaches a publish tool" assertion a tautology (tools.ts's allowlist check
// is proved independently, and thoroughly, in tools.test.ts already; that is
// not what this file exists to add).
//
// The harder problem this file has to solve: this project never talks to a
// real model (STANDING-CONTEXT R1 / "no paid model calls, ever"), so there
// is no model here that could actually be fooled by a payload's natural-
// language content. `credulousProvider` below stands in for the worst case
// instead of trying to simulate whether any particular payload's wording
// would work on a real one: on every call it responds exactly as if the
// model had already been fully compromised into requesting the disallowed
// "publish.meta" tool, regardless of what the untrusted block actually
// says. Driving that worst-case response through the REAL runAgent loop
// (interpretToolCall -> tools.invoke -> the allowlist check inside T4's
// registry) proves the property that actually matters: even total model
// compromise cannot reach a disallowed tool, because the defence lives in
// code the model cannot influence, not in hoping the model behaves.
import { describe, expect, it, vi } from "vitest";
import { INJECTION_PAYLOADS } from "@smos/testing";
import { runAgent, type RunStore } from "./runtime.ts";
import { createToolRegistry } from "./tools.ts";
import { createFakeProvider, createGateway } from "@smos/model-gateway";
import type { GenerateRequest, GenerateResult, ModelProvider } from "@smos/model-gateway";
import { researchAgent } from "./roles/index.ts";
import { ALL_AGENT_ROLES, M1_ACTIVATED_AGENTS, newId } from "@smos/domain";

const registry = ALL_AGENT_ROLES.map((role) => ({
  role,
  versionId: newId(),
  activated: (M1_ACTIVATED_AGENTS as readonly string[]).includes(role),
  toolAllowlist: researchAgent.toolAllowlist,
  prohibitedActions: [],
}));

function mockStore(): RunStore & {
  recordToolCall: ReturnType<typeof vi.fn>;
} {
  return {
    createRun: vi.fn(async () => newId()),
    checkpoint: vi.fn(async () => undefined),
    finishRun: vi.fn(async () => undefined),
    recordToolCall: vi.fn(async () => undefined),
  };
}

/**
 * Worst-case stand-in for "the model was fully compromised by whatever
 * untrusted content it just read" -- see the file header. Deliberately
 * ignores its own input entirely and always asks for the disallowed tool,
 * so every payload in the corpus is driven through the identical, maximally
 * adversarial model response; what varies per test is only the payload text
 * sitting inside the wrapUntrusted block of the prompt this provider is
 * handed (asserted separately below), never this provider's behaviour.
 */
function credulousProvider(): ModelProvider {
  return {
    name: "credulous",
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      return {
        text: JSON.stringify({ toolCall: "publish.meta", args: { text: "anything" } }),
        tokensIn: req.system.length + req.input.length,
        tokensOut: 12,
        costUsd: 0,
        modelVersion: "credulous-1",
      };
    },
  };
}

function interpretAsToolCall(raw: string): { name: string; args: unknown } | null {
  try {
    const parsed = JSON.parse(raw) as { toolCall?: string; args?: unknown };
    return parsed.toolCall ? { name: parsed.toolCall, args: parsed.args ?? {} } : null;
  } catch {
    return null;
  }
}

describe("E9 prompt injection regression", () => {
  it("has a meaningful payload corpus", () => {
    expect(INJECTION_PAYLOADS.length).toBeGreaterThanOrEqual(10);
  });

  it.each(INJECTION_PAYLOADS)(
    "$name: never reaches a publish tool, even driven through runAgent against a fully-compromised model",
    async ({ text }) => {
      const publish = vi.fn();
      const tools = createToolRegistry([{ name: "publish.meta", handler: publish }]);
      const prompt = researchAgent.buildPrompt({
        topic: "đối thủ",
        brandVoice: "chuyên nghiệp",
        externalSources: [{ url: "https://evil.test", accessedAt: new Date(), text }],
      });

      // The payload is inside the untrusted block, never in the system
      // prompt -- wrapUntrusted's own boundary, asserted here at the point
      // where a real runAgent call is about to consume this exact prompt.
      // Not asserting `prompt.input` contains `text` verbatim: for a
      // payload shaped like a closing tag (the "fence escape" entry),
      // wrapUntrusted's neutraliseCloseTag deliberately HTML-entity-encodes
      // that exact substring before it is ever assembled into the prompt --
      // the defence changing the text is the correct outcome, not a bug
      // this test should mask by weakening the check.
      expect(prompt.system).not.toContain(text);
      expect(prompt.input).toContain("<untrusted_content");

      const store = mockStore();
      const gateway = createGateway({
        provider: credulousProvider(),
        budgetUsd: 1,
        maxWallclockMs: 5000,
        estimatedCostUsd: 0.01,
      });

      await expect(
        runAgent({
          role: "research",
          registry,
          tools,
          gateway,
          workspaceId: newId(),
          campaignId: newId(),
          correlationId: newId(),
          buildPrompt: () => prompt,
          parse: researchAgent.parse,
          interpretToolCall: interpretAsToolCall,
          store,
        }),
      ).rejects.toThrow(/not on the tool allowlist/i);

      // The handler backing the disallowed tool must never have run, no
      // matter what the payload said or how the (simulated-compromised)
      // model phrased its request.
      expect(publish).not.toHaveBeenCalled();
      // The refused attempt is still audited (T6/T7's tool_call trail) --
      // a defence that refuses silently is exactly as dangerous as one
      // that does not refuse at all, per this project's own audit
      // requirements.
      expect(store.recordToolCall).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ name: "publish.meta", allowed: false }),
      );
    },
  );

  // Control case, still driven entirely through runAgent (not tools.invoke
  // directly): confirms the refusal above is coming from the real registry
  // wired into the real runtime, by using the same fake provider this file
  // uses everywhere else and the same well-behaved research prompt with NO
  // injected content at all -- a plain, uncompromised research run with a
  // tool outside its allowlist offered must fail exactly the same way.
  it("a well-formed tool request for a tool outside the role's allowlist is refused by runAgent even with no injected content present", async () => {
    const publish = vi.fn();
    const tools = createToolRegistry([{ name: "publish.meta", handler: publish }]);
    const store = mockStore();

    await expect(
      runAgent({
        role: "research",
        registry,
        tools,
        gateway: createGateway({
          provider: credulousProvider(),
          budgetUsd: 1,
          maxWallclockMs: 5000,
          estimatedCostUsd: 0.01,
        }),
        workspaceId: newId(),
        campaignId: newId(),
        correlationId: newId(),
        buildPrompt: () => ({ system: "s", input: "no untrusted content here at all", schemaName: "research.v1" }),
        parse: researchAgent.parse,
        interpretToolCall: interpretAsToolCall,
        store,
      }),
    ).rejects.toThrow(/not on the tool allowlist/i);
    expect(publish).not.toHaveBeenCalled();
  });

  // Sanity check that the harness itself is real: an allowlisted role asking
  // for a tool it IS allowed to use must actually succeed through the same
  // runAgent path, so "never reaches a publish tool" above is a refusal by
  // the allowlist, not an artefact of a broken harness that would refuse
  // every tool call regardless of allowlist membership.
  it("harness sanity: an allowlisted tool call through the same runAgent path is NOT refused", async () => {
    const fetchUrl = vi.fn(async () => ({ ok: true }));
    const tools = createToolRegistry([{ name: "fetch.url", handler: fetchUrl }]);
    const store = mockStore();
    let calls = 0;
    const provider: ModelProvider = {
      name: "scripted",
      async generate() {
        calls++;
        const text = calls === 1 ? JSON.stringify({ toolCall: "fetch.url", args: {} }) : JSON.stringify({ findings: [] });
        return { text, tokensIn: 1, tokensOut: 1, costUsd: 0, modelVersion: "m" };
      },
    };

    const result = await runAgent({
      role: "research",
      registry,
      tools,
      gateway: createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.01 }),
      workspaceId: newId(),
      campaignId: newId(),
      correlationId: newId(),
      buildPrompt: () => ({ system: "s", input: "i", schemaName: "research.v1" }),
      parse: researchAgent.parse,
      interpretToolCall: interpretAsToolCall,
      store,
    });

    expect(fetchUrl).toHaveBeenCalledOnce();
    expect(result.output).toEqual({ findings: [] });
  });
});

// Keeps createFakeProvider imported and exercised so a future refactor that
// breaks the ordinary (non-adversarial) fake-provider path in this file's
// imports is caught here too, not only in runtime.test.ts.
describe("E9 fixture sanity", () => {
  it("createFakeProvider still answers the research schema used throughout this file", async () => {
    const provider = createFakeProvider({ "research.v1": JSON.stringify({ findings: [] }) });
    const result = await provider.generate({ system: "s", input: "i", schemaName: "research.v1", maxOutputTokens: 100 });
    expect(JSON.parse(result.text)).toEqual({ findings: [] });
  });
});
