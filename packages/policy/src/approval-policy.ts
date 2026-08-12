// T8: the approval gate policy. `evaluateGate` decides ONE thing: whether an
// action needs a human ApprovalDecision before it may proceed
// (packages/domain/src/approval.ts:decideApproval already refuses to grant
// that decision to anyone but a user actor -- this module decides only
// whether the gate exists, never who may open it).
import { classifyRisk, type RiskLevel } from "./risk.ts";

// Fix round 1, IMPORTANT: the wiring risk flagged in the original report,
// made impossible instead of merely documented. `GateInput.actionKind` used
// to be a plain `string`, so nothing distinguished "derived from the
// construction-time tool allowlist" from "arbitrary model-parsed text" --
// a future caller could pipe `interpretToolCall(raw)`'s pre-allowlist-check
// name (packages/agents/src/runtime.ts) straight into `actionKind` with no
// type error at all. `TrustedActionKind` can only be produced by
// `trustActionKind`, which checks the value against the caller's actual
// allowlist, so `evaluateGate({ actionKind: someModelText, ... })` now
// fails to compile unless `someModelText` already went through that check.
// A brand is erasable with `as`, so `trustActionKind` also re-validates at
// runtime: the brand stops the accident, the runtime check stops the
// deliberate bypass.
declare const trustedActionKindBrand: unique symbol;
export type TrustedActionKind = string & { readonly [trustedActionKindBrand]: true };

/**
 * The only way to produce a `TrustedActionKind`. `name` must be literally
 * present in `allowlist` -- pass the invoking agent's real
 * `entry.toolAllowlist` (T4's construction-time snapshot), never a list
 * built from the same untrusted source as `name` itself.
 */
export function trustActionKind(name: string, allowlist: readonly string[]): TrustedActionKind {
  if (typeof name !== "string") {
    throw new TypeError(`trustActionKind requires a string name; got ${typeof name}.`);
  }
  if (!allowlist.includes(name)) {
    throw new Error(`"${name}" is not on the tool allowlist; refusing to trust it as an action kind`);
  }
  return name as TrustedActionKind;
}

export interface GateInput {
  actionKind: TrustedActionKind;
  text: string;
  qaVerdict: "pass" | "block";
}

export interface GateDecision {
  gate: "none" | "approval";
  escalate: boolean;
  ruleId: string;
  ruleVersion: number;
  reason: string;
}

export const POLICY_RULE_ID = "POLICY-EXTERNAL-ACTION";
export const POLICY_RULE_VERSION = 1;

const NEEDS_APPROVAL: ReadonlySet<RiskLevel> = new Set(["medium", "high", "critical"]);

/**
 * Note what is absent: `qaVerdict` is read only to appear in provenance --
 * it never widens or narrows `NEEDS_APPROVAL.has(risk)`. Quality tells the
 * founder how good the work is; only a recorded ApprovalDecision from a user
 * actor (packages/domain/src/approval.ts) grants permission. A caller that
 * fed `qaVerdict` into the gate condition would let a self-graded QA pass
 * stand in for a human, which is exactly the second route to APPROVED the
 * P1 database invariant exists to close off.
 */
export function evaluateGate(input: GateInput): GateDecision {
  const risk = classifyRisk({ kind: input.actionKind, text: input.text });
  const gate = NEEDS_APPROVAL.has(risk) ? "approval" : "none";
  return {
    gate,
    escalate: risk === "critical",
    ruleId: POLICY_RULE_ID,
    ruleVersion: POLICY_RULE_VERSION,
    reason: `Action "${input.actionKind}" classified as ${risk} risk`,
  };
}
