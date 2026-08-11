import type { Id } from "./ids.ts";

/**
 * Actor kind is the single thing that decides whether an approval decision
 * is legitimate. An agent can never be the actor on an ApprovalDecision
 * (blueprint section 13.1); the database enforces this too.
 */
export type Actor =
  | { kind: "user"; userId: Id }
  | { kind: "agent"; agentRunId: Id; agentVersionId: Id }
  | { kind: "system"; reason: string };

export function isUserActor(a: Actor): a is Extract<Actor, { kind: "user" }> { return a.kind === "user"; }
export function isAgentActor(a: Actor): a is Extract<Actor, { kind: "agent" }> { return a.kind === "agent"; }
