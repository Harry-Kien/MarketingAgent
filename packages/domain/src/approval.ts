import { isUserActor, type Actor } from "./actor.ts";
import { ApprovalIntegrityError } from "./errors.ts";
import { newId, type Id } from "./ids.ts";

export interface PolicyFlag { ruleId: string; ruleVersion: number; severity: "info" | "warn" | "block"; message: string; }

export interface ApprovalRequest {
  id: Id; workspaceId: Id; campaignId: Id; contentVersionId: Id;
  targetChannel: string; policyFlags: PolicyFlag[]; evidenceCitationIds: Id[];
  estimatedImpact: string | null; createdAt: Date;
}

export type ApprovalDecisionKind = "approve" | "reject" | "request_changes";

/**
 * Late-review CRITICAL 1: a decision must record WHAT was approved, not
 * merely THAT something was. `contentVersionId` and `targetChannel` are
 * snapshotted here, off the request, at the moment of the decision, and are
 * never re-read from `approval_request` afterwards -- that row is precisely
 * what the reviewer's retarget attack rewrote. See
 * infra/migrations/0031_approval_request_frozen_after_decision.sql, which
 * freezes the request once decided AND ties this snapshot to it with a
 * composite foreign key, so the two can never disagree.
 */
export interface ApprovalDecision {
  id: Id; workspaceId: Id; approvalRequestId: Id; actorUserId: Id;
  decision: ApprovalDecisionKind; reason: string; decidedAt: Date;
  contentVersionId: Id; targetChannel: string;
}

/**
 * Blueprint section 13.2: an approval request missing any required element
 * must not render an approve button. Callers assert before rendering, and
 * the thrown message is specific enough for the UI to explain the refusal
 * without inventing its own copy.
 */
export function assertRenderable(req: ApprovalRequest): void {
  if (req.evidenceCitationIds.length === 0) {
    throw new ApprovalIntegrityError("Approval request has no evidence; it cannot be presented for approval");
  }
  if (req.targetChannel.trim().length === 0) {
    throw new ApprovalIntegrityError("Approval request has no target channel; it cannot be presented for approval");
  }
}

/**
 * E4: only a human user can decide an approval request. Task 3 established
 * this in the lifecycle machine as "APPROVED requires a user actor" -- both
 * agent and system actors are refused here, not merely agent actors. The
 * database migration (0007_approval.sql) enforces the same rule with a
 * foreign key to user_account plus an independent actor_kind CHECK, so a
 * bug here cannot alone produce an approved-but-never-reviewed publication.
 */
export function decideApproval(
  req: ApprovalRequest,
  input: { actor: Actor; decision: ApprovalDecisionKind; reason: string },
): ApprovalDecision {
  if (!isUserActor(input.actor)) {
    throw new ApprovalIntegrityError("Only a human user can decide an approval request");
  }
  if (input.reason.trim().length === 0) {
    throw new ApprovalIntegrityError("An approval decision requires a reason");
  }
  assertRenderable(req);
  return {
    id: newId(), workspaceId: req.workspaceId, approvalRequestId: req.id,
    actorUserId: input.actor.userId, decision: input.decision,
    reason: input.reason.trim(), decidedAt: new Date(),
    contentVersionId: req.contentVersionId, targetChannel: req.targetChannel,
  };
}
