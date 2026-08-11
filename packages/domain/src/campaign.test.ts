import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import { createCampaign, transitionCampaign } from "./campaign.ts";
import { InvalidTransitionError } from "./errors.ts";
import type { Actor } from "./actor.ts";

const user: Actor = { kind: "user", userId: newId() };
const agent: Actor = { kind: "agent", agentRunId: newId(), agentVersionId: newId() };
const seed = () =>
  createCampaign({ workspaceId: newId(), goalId: newId(), name: "Ra mắt gói tư vấn", actor: user, correlationId: newId() });

describe("createCampaign", () => {
  it("starts in DRAFT at version 1", () => {
    const { campaign } = seed();
    expect(campaign.state).toBe("DRAFT");
    expect(campaign.version).toBe(1);
  });
  it("rejects a blank name", () => {
    expect(() => createCampaign({ workspaceId: newId(), goalId: newId(), name: "   ", actor: user, correlationId: newId() }))
      .toThrow(/name/i);
  });
  it("records an initial DRAFT -> DRAFT transition without going through canTransition", () => {
    const { transition } = seed();
    expect(transition.from).toBe("DRAFT");
    expect(transition.to).toBe("DRAFT");
    expect(transition.version).toBe(1);
  });
});

describe("transitionCampaign", () => {
  it("bumps version and returns a transition record", () => {
    const { campaign } = seed();
    const next = transitionCampaign(campaign, "RESEARCHING", { actor: agent, reason: "orchestrator dispatch", correlationId: newId() });
    expect(next.campaign.state).toBe("RESEARCHING");
    expect(next.campaign.version).toBe(2);
    expect(next.transition.actor).toEqual(agent);
  });

  it("never mutates the input campaign", () => {
    const { campaign } = seed();
    transitionCampaign(campaign, "RESEARCHING", { actor: user, reason: "x", correlationId: newId() });
    expect(campaign.state).toBe("DRAFT");
    expect(campaign.version).toBe(1);
  });

  it("refuses an illegal jump", () => {
    const { campaign } = seed();
    expect(() => transitionCampaign(campaign, "EXECUTING", { actor: user, reason: "x", correlationId: newId() }))
      .toThrow(InvalidTransitionError);
  });

  it("refuses APPROVED driven by an agent", () => {
    let c = seed().campaign;
    for (const to of ["RESEARCHING", "PLANNED", "IN_PROGRESS", "INTERNAL_REVIEW", "WAITING_APPROVAL"] as const) {
      c = transitionCampaign(c, to, { actor: agent, reason: "step", correlationId: newId() }).campaign;
    }
    expect(() => transitionCampaign(c, "APPROVED", { actor: agent, reason: "self approve", correlationId: newId(), hasApprovalDecision: true }))
      .toThrow(/agent/i);
  });

  it("refuses APPROVED driven by a system actor even from WAITING_APPROVAL with a decision", () => {
    let c = seed().campaign;
    const system: Actor = { kind: "system", reason: "scheduler" };
    for (const to of ["RESEARCHING", "PLANNED", "IN_PROGRESS", "INTERNAL_REVIEW", "WAITING_APPROVAL"] as const) {
      c = transitionCampaign(c, to, { actor: user, reason: "step", correlationId: newId() }).campaign;
    }
    expect(() => transitionCampaign(c, "APPROVED", { actor: system, reason: "auto approve", correlationId: newId(), hasApprovalDecision: true }))
      .toThrow(InvalidTransitionError);
  });

  it("refuses BLOCKED recovering directly into APPROVED or beyond", () => {
    let c = seed().campaign;
    for (const to of ["RESEARCHING", "PLANNED"] as const) {
      c = transitionCampaign(c, to, { actor: user, reason: "step", correlationId: newId() }).campaign;
    }
    c = transitionCampaign(c, "BLOCKED", { actor: user, reason: "blocked", correlationId: newId() }).campaign;
    expect(() => transitionCampaign(c, "APPROVED", { actor: user, reason: "skip ahead", correlationId: newId(), hasApprovalDecision: true }))
      .toThrow(InvalidTransitionError);
  });
});
