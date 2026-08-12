import {
  assertRenderable,
  decideApproval,
  TenantViolationError,
  type ApprovalDecision,
  type ApprovalDecisionKind,
  type ApprovalRequest,
  type Id,
} from "@smos/domain";
import { t } from "../../i18n/index.ts";

export interface PerformApprovalInput {
  approvalRequestId: Id;
  decision: ApprovalDecisionKind;
  reason: string;
  session: { userId: Id; workspaceId: Id };
}

export interface ApprovalAuditEvent {
  eventType: string;
  workspaceId: Id;
  actorUserId: Id;
  subjectId: Id;
  payload: Record<string, unknown>;
}

export interface PerformApprovalDeps {
  loadRequest(approvalRequestId: Id): Promise<ApprovalRequest>;
  isChannelConnected(targetChannel: string): Promise<boolean>;
  saveDecision(decision: ApprovalDecision): Promise<void>;
  writeAudit(event: ApprovalAuditEvent): Promise<void>;
}

// One audit event type per decision kind, so "reject" and "request_changes"
// are never recorded (or later confused, reading the audit trail back) as
// if they were "approval.granted".
const EVENT_TYPE_BY_DECISION: Record<ApprovalDecisionKind, string> = {
  approve: "approval.granted",
  reject: "approval.rejected",
  request_changes: "approval.changes_requested",
};

/**
 * The single place an approval decision is recorded. This is deliberately
 * the ONLY entry point: it requires an explicit `decision` (never inferred
 * or defaulted) and a non-blank `reason`, both real input from the person
 * calling it, and it builds the acting `Actor` exclusively from
 * `input.session.userId` -- there is no parameter through which an agent or
 * system identity could be substituted. `decideApproval`
 * (packages/domain/src/approval.ts) independently refuses anything that
 * isn't a `{ kind: "user" }` Actor, and the database's own
 * `approval_decision.actor_kind CHECK (actor_kind = 'user')` plus its
 * foreign key to `user_account` refuse it a third, independent way. Nothing
 * in this function can approve on a user's behalf, pre-select a decision,
 * or trigger approval as a side effect of some other action -- it only ever
 * runs because a human explicitly named a decision and a reason.
 *
 * `deps` is injected (not a direct database/network call) so this stays
 * testable without a live Postgres -- `submit-approval.ts` wires the real
 * implementation (DB reads/writes inside `withTenant`, one shared
 * transaction) on top of a real, server-resolved session.
 */
export async function performApproval(
  input: PerformApprovalInput,
  deps: PerformApprovalDeps,
): Promise<ApprovalDecision> {
  const req = await deps.loadRequest(input.approvalRequestId);

  // Defense in depth: even if `loadRequest` itself had a bug and returned a
  // request from a different workspace, this refuses it here too, before
  // any evidence/channel/actor check ever runs.
  if (req.workspaceId !== input.session.workspaceId) {
    throw new TenantViolationError("Approval request belongs to a different workspace than the caller's session");
  }

  // Blueprint 13.2 / Global Constraint: missing evidence or a blank target
  // channel must never even reach a decision.
  assertRenderable(req);

  // T17: a target channel that isn't actually connected must also refuse,
  // independently of whether the request itself is otherwise renderable.
  const connected = await deps.isChannelConnected(req.targetChannel);
  if (!connected) {
    throw new Error(t("approval.disconnected"));
  }

  // decideApproval is the domain's own gate: it re-validates evidence, the
  // reason, and -- the one rule this whole task exists to protect --
  // refuses any actor that isn't a real user, independently of everything
  // checked above.
  const decision = decideApproval(req, {
    actor: { kind: "user", userId: input.session.userId },
    decision: input.decision,
    reason: input.reason,
  });

  await deps.saveDecision(decision);
  await deps.writeAudit({
    eventType: EVENT_TYPE_BY_DECISION[input.decision],
    workspaceId: req.workspaceId,
    actorUserId: input.session.userId,
    subjectId: req.id,
    payload: {
      decision: input.decision,
      campaignId: req.campaignId,
      contentVersionId: req.contentVersionId,
      targetChannel: req.targetChannel,
    },
  });

  return decision;
}
