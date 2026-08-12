// T8: the approval gate policy. `evaluateGate` decides ONE thing: whether an
// action needs a human ApprovalDecision before it may proceed
// (packages/domain/src/approval.ts:decideApproval already refuses to grant
// that decision to anyone but a user actor -- this module decides only
// whether the gate exists, never who may open it).
import { classifyRisk, type RiskLevel } from "./risk.ts";

export interface GateInput {
  actionKind: string;
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
