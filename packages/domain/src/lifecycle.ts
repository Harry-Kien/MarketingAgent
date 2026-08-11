import { isAgentActor, type Actor } from "./actor.ts";
import { InvalidTransitionError } from "./errors.ts";
import type { Id } from "./ids.ts";

/**
 * The 11 states a campaign/task moves through in sequence, start to finish.
 * Order matters: canTransition treats adjacency in this array as the only
 * forward path.
 */
export const MAIN_STATES = [
  "DRAFT",
  "RESEARCHING",
  "PLANNED",
  "IN_PROGRESS",
  "INTERNAL_REVIEW",
  "WAITING_APPROVAL",
  "APPROVED",
  "SCHEDULED",
  "EXECUTING",
  "MEASURING",
  "COMPLETED",
] as const;

/** Side states reachable from (almost) anywhere live, off the main sequence. */
export const SIDE_STATES = ["BLOCKED", "FAILED_RETRYABLE", "FAILED_TERMINAL", "CANCELLED"] as const;

export type MainState = (typeof MAIN_STATES)[number];
export type SideState = (typeof SIDE_STATES)[number];
export type LifecycleState = MainState | SideState;

const TERMINAL: ReadonlySet<LifecycleState> = new Set(["COMPLETED", "FAILED_TERMINAL", "CANCELLED"]);

/** The only two backward edges: QA veto, and a rejected approval. */
const REWORK_EDGES: ReadonlyArray<[LifecycleState, LifecycleState]> = [
  ["INTERNAL_REVIEW", "IN_PROGRESS"],
  ["WAITING_APPROVAL", "IN_PROGRESS"],
];

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  if (from === to) return false;
  if (TERMINAL.has(from)) return false;
  if (to === "BLOCKED" || to === "CANCELLED" || to === "FAILED_RETRYABLE" || to === "FAILED_TERMINAL") return true;
  if (from === "BLOCKED" || from === "FAILED_RETRYABLE") return MAIN_STATES.includes(to as MainState);
  if (REWORK_EDGES.some(([f, t]) => f === from && t === to)) return true;
  const i = MAIN_STATES.indexOf(from as MainState);
  const j = MAIN_STATES.indexOf(to as MainState);
  return i >= 0 && j === i + 1;
}

export interface TransitionInput {
  from: LifecycleState;
  to: LifecycleState;
  actor: Actor;
  reason: string;
  correlationId: Id;
  version: number;
  hasApprovalDecision?: boolean | undefined;
}

export interface TransitionRecord {
  from: LifecycleState;
  to: LifecycleState;
  actor: Actor;
  reason: string;
  correlationId: Id;
  version: number;
  occurredAt: Date;
}

function requireReason(reason: string): void {
  if (reason.trim().length === 0) {
    throw new InvalidTransitionError("A transition reason is required and cannot be blank");
  }
}

export function applyTransition(input: TransitionInput): TransitionRecord {
  requireReason(input.reason);
  if (!canTransition(input.from, input.to)) {
    throw new InvalidTransitionError(`Transition ${input.from} -> ${input.to} is not allowed`);
  }
  if (input.to === "APPROVED") {
    if (input.hasApprovalDecision !== true) {
      throw new InvalidTransitionError("APPROVED requires a recorded ApprovalDecision");
    }
    if (isAgentActor(input.actor)) {
      throw new InvalidTransitionError("An agent actor can never approve; only a user can");
    }
  }
  return {
    from: input.from,
    to: input.to,
    actor: input.actor,
    reason: input.reason,
    correlationId: input.correlationId,
    version: input.version,
    occurredAt: new Date(),
  };
}

/**
 * The one deliberate exception to canTransition: campaign/task creation is
 * recorded as a DRAFT -> DRAFT transition so the audit trail (Task 13) has a
 * uniform "every state change is a TransitionRecord" story, including the
 * very first one. canTransition correctly rejects from === to for every real
 * transition, so this bypasses it explicitly rather than forcing a cast
 * through the type system.
 */
export function createInitialTransition(input: Omit<TransitionInput, "from" | "to">): TransitionRecord {
  requireReason(input.reason);
  return {
    from: "DRAFT",
    to: "DRAFT",
    actor: input.actor,
    reason: input.reason,
    correlationId: input.correlationId,
    version: input.version,
    occurredAt: new Date(),
  };
}
