"use server";

import { revalidatePath } from "next/cache";
import { withTenant, type TenantTx } from "@smos/db";
import {
  newId,
  type ApprovalDecision,
  type ApprovalDecisionKind,
  type ApprovalRequest,
  type Id,
  type PolicyFlag,
} from "@smos/domain";
import { requireWorkspace } from "../auth.ts";
import { getPool } from "../db.ts";
import { isChannelConnected as checkChannelConnected } from "../channel-status.ts";
import { performApproval, type ApprovalAuditEvent, type PerformApprovalDeps } from "./approve.ts";

const VALID_DECISIONS: ReadonlySet<string> = new Set<ApprovalDecisionKind>([
  "approve",
  "reject",
  "request_changes",
]);

interface ApprovalRequestRow {
  id: string;
  workspace_id: string;
  campaign_id: string;
  content_version_id: string;
  target_channel: string;
  policy_flags: PolicyFlag[] | null;
  estimated_impact: string | null;
  created_at: Date;
}

async function loadApprovalRequestTx(tx: TenantTx, workspaceId: Id, approvalRequestId: Id): Promise<ApprovalRequest> {
  const result = await tx.query(
    // Late-review MINOR (d): policy_flags was never selected and
    // `policyFlags` below was hardcoded to [] -- so performApproval's
    // blocking-flag gate could never see a flag, and the flags the Approval
    // Center renders (queries.ts DOES select them) gated nothing. The gate
    // and the screen now read the same column.
    `select id, workspace_id, campaign_id, content_version_id, target_channel, policy_flags, estimated_impact, created_at
     from approval_request
     where id = $1 and workspace_id = $2`,
    [approvalRequestId, workspaceId],
  );
  const row = result.rows[0] as ApprovalRequestRow | undefined;
  if (!row) throw new Error("Approval request not found");

  const citations = await tx.query(
    `select id from source_citation where content_version_id = $1 and workspace_id = $2`,
    [row.content_version_id, workspaceId],
  );

  return {
    id: row.id as Id,
    workspaceId: row.workspace_id as Id,
    campaignId: row.campaign_id as Id,
    contentVersionId: row.content_version_id as Id,
    targetChannel: row.target_channel,
    policyFlags: row.policy_flags ?? [],
    evidenceCitationIds: (citations.rows as Array<{ id: string }>).map((r) => r.id as Id),
    estimatedImpact: row.estimated_impact,
    createdAt: row.created_at,
  };
}

async function saveDecisionTx(tx: TenantTx, decision: ApprovalDecision): Promise<void> {
  await tx.query(
    // content_version_id / target_channel are the decision's own snapshot of
    // WHAT was approved (late-review CRITICAL 1). A composite foreign key
    // (0031_approval_request_frozen_after_decision.sql) refuses this INSERT
    // outright if the snapshot disagrees with the request being answered, so
    // there is no way for this statement to record a decision "for" content
    // the founder was not actually shown.
    `insert into approval_decision (id, workspace_id, approval_request_id, actor_user_id, actor_kind, decision, reason, decided_at, content_version_id, target_channel)
     values ($1, $2, $3, $4, 'user', $5, $6, $7, $8, $9)`,
    [
      decision.id,
      decision.workspaceId,
      decision.approvalRequestId,
      decision.actorUserId,
      decision.decision,
      decision.reason,
      decision.decidedAt,
      decision.contentVersionId,
      decision.targetChannel,
    ],
  );
}

async function writeAuditTx(tx: TenantTx, event: ApprovalAuditEvent): Promise<void> {
  await tx.query(
    `insert into audit_log (id, workspace_id, event_type, actor_kind, actor_user_id, subject_type, subject_id, payload)
     values ($1, $2, $3, 'user', $4, 'approval_request', $5, $6)`,
    [newId(), event.workspaceId, event.eventType, event.actorUserId, event.subjectId, JSON.stringify(event.payload)],
  );
}

/**
 * The one real entry point a browser can reach to decide an approval
 * request. Bound as a Next.js Server Action (`"use server"`), invoked from
 * a real `<form action={submitApproval.bind(null, approvalRequestId)}>` in
 * `approvals/[id]/page.tsx` with three distinct submit buttons (`name=
 * "decision"`, one `value` each for approve/reject/request_changes) -- the
 * decision reaching this function is always exactly whichever button the
 * founder physically clicked, never a default, and `reason` is always
 * whatever they typed, never pre-filled. `requireWorkspace()` resolves the
 * actor from the server session, not from anything the form posted, so the
 * approvalRequestId is the only value the browser supplies here at all.
 *
 * `isChannelConnected` is now wired to the real `integration` table
 * (P4 Task 9, closing the gap this comment used to document: P3 wrote this
 * as a stub that always returned `false` because there was no channel-
 * integration table yet at the time -- 0028_integration.sql has since added
 * one). `checkChannelConnected` (../channel-status.ts) reads it inside
 * `withTenant`, scoped to this same `workspaceId`, and reports `true` only
 * for a genuinely "connected" or sandbox-"verified" row -- never inferred
 * from silence, never from a "not_implemented"/"disconnected" row. A
 * workspace with no integration configured yet still refuses here, exactly
 * as before, but now for the real, verifiable reason ("no row exists")
 * rather than an unconditional stub.
 */
export async function submitApproval(approvalRequestId: Id, formData: FormData): Promise<void> {
  const decisionRaw = formData.get("decision");
  const reasonRaw = formData.get("reason");
  if (typeof decisionRaw !== "string" || !VALID_DECISIONS.has(decisionRaw)) {
    throw new Error("A decision (approve, reject, or request_changes) is required");
  }
  if (typeof reasonRaw !== "string") {
    throw new Error("A reason is required");
  }
  const decision = decisionRaw as ApprovalDecisionKind;

  const { userId, workspaceId } = await requireWorkspace();

  await withTenant(getPool(), workspaceId, async (tx) => {
    const deps: PerformApprovalDeps = {
      loadRequest: (id) => loadApprovalRequestTx(tx, workspaceId, id),
      isChannelConnected: (channel) => checkChannelConnected(getPool(), workspaceId, channel),
      saveDecision: (d) => saveDecisionTx(tx, d),
      writeAudit: (event) => writeAuditTx(tx, event),
    };
    await performApproval(
      { approvalRequestId, decision, reason: reasonRaw, session: { userId, workspaceId } },
      deps,
    );
  });

  revalidatePath("/approvals");
  revalidatePath(`/approvals/${approvalRequestId}`);
}
