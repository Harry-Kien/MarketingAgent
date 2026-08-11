import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import {
  applyTransition,
  canTransition,
  createInitialTransition,
  MAIN_STATES,
  SIDE_STATES,
} from "./lifecycle.ts";
import { InvalidTransitionError } from "./errors.ts";
import type { Actor } from "./actor.ts";

const user: Actor = { kind: "user", userId: newId() };
const agent: Actor = { kind: "agent", agentRunId: newId(), agentVersionId: newId() };
const system: Actor = { kind: "system", reason: "scheduler" };
const base = { actor: user, reason: "test", correlationId: newId(), version: 1 };

describe("canTransition — happy path", () => {
  it("walks the full main sequence", () => {
    for (let i = 0; i < MAIN_STATES.length - 1; i++) {
      expect(canTransition(MAIN_STATES[i]!, MAIN_STATES[i + 1]!)).toBe(true);
    }
  });
});

describe("canTransition — rejections", () => {
  it("refuses to skip a stage", () => {
    expect(canTransition("DRAFT", "APPROVED")).toBe(false);
    expect(canTransition("IN_PROGRESS", "EXECUTING")).toBe(false);
    expect(canTransition("RESEARCHING", "INTERNAL_REVIEW")).toBe(false);
    expect(canTransition("DRAFT", "COMPLETED")).toBe(false);
  });

  it("refuses to go backwards except the two allowed rework edges", () => {
    expect(canTransition("COMPLETED", "DRAFT")).toBe(false);
    expect(canTransition("INTERNAL_REVIEW", "IN_PROGRESS")).toBe(true);
    expect(canTransition("WAITING_APPROVAL", "IN_PROGRESS")).toBe(true);
  });

  it("refuses every other backward move that is not one of the two rework edges", () => {
    expect(canTransition("PLANNED", "DRAFT")).toBe(false);
    expect(canTransition("IN_PROGRESS", "RESEARCHING")).toBe(false);
    expect(canTransition("IN_PROGRESS", "PLANNED")).toBe(false);
    expect(canTransition("APPROVED", "WAITING_APPROVAL")).toBe(false);
    expect(canTransition("EXECUTING", "SCHEDULED")).toBe(false);
    expect(canTransition("SCHEDULED", "APPROVED")).toBe(false);
    expect(canTransition("MEASURING", "EXECUTING")).toBe(false);
    // rework edges only run one direction
    expect(canTransition("IN_PROGRESS", "INTERNAL_REVIEW")).toBe(true);
    expect(canTransition("IN_PROGRESS", "WAITING_APPROVAL")).toBe(false);
  });

  it("allows any live state to become BLOCKED or CANCELLED", () => {
    expect(canTransition("RESEARCHING", "BLOCKED")).toBe(true);
    expect(canTransition("SCHEDULED", "CANCELLED")).toBe(true);
    expect(canTransition("PLANNED", "FAILED_RETRYABLE")).toBe(true);
    expect(canTransition("EXECUTING", "FAILED_TERMINAL")).toBe(true);
  });

  it("lets BLOCKED and FAILED_RETRYABLE resume into any main state, and into each other's side state", () => {
    expect(canTransition("BLOCKED", "IN_PROGRESS")).toBe(true);
    expect(canTransition("BLOCKED", "DRAFT")).toBe(true);
    expect(canTransition("FAILED_RETRYABLE", "EXECUTING")).toBe(true);
    expect(canTransition("BLOCKED", "CANCELLED")).toBe(true);
  });

  it("refuses to leave a terminal state", () => {
    expect(canTransition("FAILED_TERMINAL", "IN_PROGRESS")).toBe(false);
    expect(canTransition("COMPLETED", "MEASURING")).toBe(false);
    expect(canTransition("CANCELLED", "DRAFT")).toBe(false);
    expect(canTransition("COMPLETED", "BLOCKED")).toBe(false);
  });

  it("refuses a no-op transition (from === to)", () => {
    expect(canTransition("DRAFT", "DRAFT")).toBe(false);
    expect(canTransition("IN_PROGRESS", "IN_PROGRESS")).toBe(false);
  });

  it("APPROVED is reachable only from WAITING_APPROVAL", () => {
    expect(canTransition("IN_PROGRESS", "APPROVED")).toBe(false);
    expect(canTransition("SCHEDULED", "APPROVED")).toBe(false);
    expect(canTransition("INTERNAL_REVIEW", "APPROVED")).toBe(false);
    expect(canTransition("WAITING_APPROVAL", "APPROVED")).toBe(true);
  });
});

describe("state inventory", () => {
  it("has 11 main states and 4 side states", () => {
    expect(MAIN_STATES.length).toBe(11);
    expect(SIDE_STATES.length).toBe(4);
  });
});

describe("applyTransition — APPROVED is special", () => {
  it("refuses APPROVED without an approval decision", () => {
    expect(() =>
      applyTransition({ ...base, from: "WAITING_APPROVAL", to: "APPROVED", hasApprovalDecision: false }),
    ).toThrow(InvalidTransitionError);
  });

  it("refuses APPROVED when the actor is an agent", () => {
    expect(() =>
      applyTransition({ ...base, actor: agent, from: "WAITING_APPROVAL", to: "APPROVED", hasApprovalDecision: true }),
    ).toThrow(/agent/i);
  });

  it("accepts APPROVED from a user with a decision", () => {
    const record = applyTransition({ ...base, from: "WAITING_APPROVAL", to: "APPROVED", hasApprovalDecision: true });
    expect(record.to).toBe("APPROVED");
    expect(record.occurredAt).toBeInstanceOf(Date);
  });

  it("refuses APPROVED even with a valid decision and a user actor if not coming from WAITING_APPROVAL", () => {
    expect(() =>
      applyTransition({ ...base, from: "SCHEDULED", to: "APPROVED", hasApprovalDecision: true }),
    ).toThrow(InvalidTransitionError);
  });

  it("refuses APPROVED for a system actor's transition too, unless it has a decision (agent check is not the only guard)", () => {
    // system actor is not an agent, so the actor-kind guard alone must not be the only requirement:
    // canTransition + hasApprovalDecision must still be enforced.
    expect(() =>
      applyTransition({ ...base, actor: system, from: "WAITING_APPROVAL", to: "APPROVED", hasApprovalDecision: false }),
    ).toThrow(InvalidTransitionError);
  });
});

describe("applyTransition — general rejections mirror canTransition", () => {
  it("throws InvalidTransitionError when skipping a stage", () => {
    expect(() => applyTransition({ ...base, from: "DRAFT", to: "APPROVED" })).toThrow(InvalidTransitionError);
  });

  it("throws InvalidTransitionError when leaving a terminal state", () => {
    expect(() => applyTransition({ ...base, from: "COMPLETED", to: "IN_PROGRESS" })).toThrow(InvalidTransitionError);
  });
});

describe("applyTransition — record completeness", () => {
  it("always records actor, reason, correlationId and version", () => {
    const record = applyTransition({ ...base, from: "DRAFT", to: "RESEARCHING" });
    expect(record).toMatchObject({ from: "DRAFT", to: "RESEARCHING", reason: "test", version: 1 });
    expect(record.correlationId).toBe(base.correlationId);
    expect(record.actor).toBe(base.actor);
  });

  it("rejects an empty reason", () => {
    expect(() => applyTransition({ ...base, reason: "  ", from: "DRAFT", to: "RESEARCHING" })).toThrow(/reason/i);
  });
});

describe("createInitialTransition — campaign creation", () => {
  it("produces a DRAFT -> DRAFT record without consulting canTransition", () => {
    // canTransition itself must still reject the no-op; createInitialTransition
    // is a deliberate, explicit bypass reserved for the creation event.
    expect(canTransition("DRAFT", "DRAFT")).toBe(false);
    const record = createInitialTransition({ actor: user, reason: "campaign created", correlationId: base.correlationId, version: 1 });
    expect(record.from).toBe("DRAFT");
    expect(record.to).toBe("DRAFT");
    expect(record.occurredAt).toBeInstanceOf(Date);
    expect(record.correlationId).toBe(base.correlationId);
    expect(record.version).toBe(1);
  });

  it("still enforces the reason-is-required rule", () => {
    expect(() =>
      createInitialTransition({ actor: user, reason: "   ", correlationId: base.correlationId, version: 1 }),
    ).toThrow(/reason/i);
  });
});
