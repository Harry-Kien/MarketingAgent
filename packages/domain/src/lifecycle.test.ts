import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import {
  applyTransition,
  canTransition,
  createInitialTransition,
  MAIN_STATES,
  SIDE_STATES,
  type LifecycleState,
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

  it("lets BLOCKED and FAILED_RETRYABLE resume only into the PRE-APPROVAL part of the main sequence, and into each other's side state", () => {
    expect(canTransition("BLOCKED", "IN_PROGRESS")).toBe(true);
    expect(canTransition("BLOCKED", "DRAFT")).toBe(true);
    expect(canTransition("FAILED_RETRYABLE", "WAITING_APPROVAL")).toBe(true);
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
    // side states must never launder into APPROVED — going through BLOCKED
    // or FAILED_RETRYABLE is not a shortcut around WAITING_APPROVAL.
    expect(canTransition("BLOCKED", "APPROVED")).toBe(false);
    expect(canTransition("FAILED_RETRYABLE", "APPROVED")).toBe(false);
    expect(canTransition("WAITING_APPROVAL", "APPROVED")).toBe(true);
  });
});

describe("fix round 1 — HIGH 1: side states must not launder into approval/execution", () => {
  it("BLOCKED and FAILED_RETRYABLE cannot reach APPROVED", () => {
    expect(canTransition("BLOCKED", "APPROVED")).toBe(false);
    expect(canTransition("FAILED_RETRYABLE", "APPROVED")).toBe(false);
  });

  it("applyTransition from BLOCKED to APPROVED throws, even with a decision and a user actor", () => {
    expect(() =>
      applyTransition({ ...base, from: "BLOCKED", to: "APPROVED", hasApprovalDecision: true }),
    ).toThrow(InvalidTransitionError);
  });

  it("BLOCKED and FAILED_RETRYABLE cannot reach SCHEDULED, EXECUTING, MEASURING or COMPLETED", () => {
    const postApproval: LifecycleState[] = ["SCHEDULED", "EXECUTING", "MEASURING", "COMPLETED"];
    for (const to of postApproval) {
      expect(canTransition("BLOCKED", to)).toBe(false);
      expect(canTransition("FAILED_RETRYABLE", to)).toBe(false);
    }
  });

  it("BLOCKED and FAILED_RETRYABLE CAN reach every pre-approval main state", () => {
    const preApproval: LifecycleState[] = [
      "DRAFT",
      "RESEARCHING",
      "PLANNED",
      "IN_PROGRESS",
      "INTERNAL_REVIEW",
      "WAITING_APPROVAL",
    ];
    for (const to of preApproval) {
      expect(canTransition("BLOCKED", to)).toBe(true);
      expect(canTransition("FAILED_RETRYABLE", to)).toBe(true);
    }
  });
});

describe("fix round 1 — HIGH 2: only a real user actor may approve", () => {
  it("a system actor is refused APPROVED with the same error type as an agent actor", () => {
    expect(() =>
      applyTransition({ ...base, actor: agent, from: "WAITING_APPROVAL", to: "APPROVED", hasApprovalDecision: true }),
    ).toThrow(InvalidTransitionError);
    expect(() =>
      applyTransition({ ...base, actor: system, from: "WAITING_APPROVAL", to: "APPROVED", hasApprovalDecision: true }),
    ).toThrow(InvalidTransitionError);
  });

  it("a user actor with a decision is still accepted from WAITING_APPROVAL", () => {
    const record = applyTransition({ ...base, actor: user, from: "WAITING_APPROVAL", to: "APPROVED", hasApprovalDecision: true });
    expect(record.to).toBe("APPROVED");
  });
});

describe("fix round 1 — full 15x15 cross-product", () => {
  // Independent re-derivation of the intended rule set (not a call-through to
  // canTransition's own internals) so this is a real cross-check, not a
  // tautology. Every (from, to) pair over all 15 states is compared.
  const ALL_STATES: LifecycleState[] = [...MAIN_STATES, ...SIDE_STATES];
  const TERMINAL_SET = new Set<LifecycleState>(["COMPLETED", "FAILED_TERMINAL", "CANCELLED"]);
  const SIDE_TARGETS = new Set<LifecycleState>(["BLOCKED", "CANCELLED", "FAILED_RETRYABLE", "FAILED_TERMINAL"]);
  const PRE_APPROVAL = new Set<LifecycleState>([
    "DRAFT",
    "RESEARCHING",
    "PLANNED",
    "IN_PROGRESS",
    "INTERNAL_REVIEW",
    "WAITING_APPROVAL",
  ]);
  const REWORK_PAIRS = new Set(["INTERNAL_REVIEW->IN_PROGRESS", "WAITING_APPROVAL->IN_PROGRESS"]);

  function expectedCanTransition(from: LifecycleState, to: LifecycleState): boolean {
    if (from === to) return false;
    if (TERMINAL_SET.has(from)) return false;
    if (SIDE_TARGETS.has(to)) return true;
    if (from === "BLOCKED" || from === "FAILED_RETRYABLE") return PRE_APPROVAL.has(to);
    if (REWORK_PAIRS.has(`${from}->${to}`)) return true;
    const i = MAIN_STATES.indexOf(from as (typeof MAIN_STATES)[number]);
    const j = MAIN_STATES.indexOf(to as (typeof MAIN_STATES)[number]);
    return i >= 0 && j === i + 1;
  }

  it("matches the intended rule set for all 225 (from, to) pairs with zero mismatches", () => {
    expect(ALL_STATES.length).toBe(15);
    let allowedCount = 0;
    let refusedCount = 0;
    const mismatches: string[] = [];
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        const actual = canTransition(from, to);
        const expected = expectedCanTransition(from, to);
        if (actual !== expected) {
          mismatches.push(`${from} -> ${to}: canTransition=${actual}, expected=${expected}`);
        }
        if (actual) allowedCount++;
        else refusedCount++;
      }
    }
    expect(mismatches).toEqual([]);
    expect(allowedCount + refusedCount).toBe(225);
    // Locked-in split so a future change to the rule set fails loudly here
    // even if it happens to preserve zero mismatches against a since-edited
    // expectedCanTransition. Values confirmed by this test run.
    expect(allowedCount).toBe(70);
    expect(refusedCount).toBe(155);
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
