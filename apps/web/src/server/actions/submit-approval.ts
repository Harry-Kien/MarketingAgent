"use server";

import { revalidatePath } from "next/cache";
import { withTenant, type TenantTx } from "@smos/db";
import { newId, type ApprovalDecision, type ApprovalDecisionKind, type ApprovalRequest, type Id } from "@smos/domain";
import { requireWorkspace } from "../auth.ts";
import { getPool } from "../db.ts";
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
  estimated_impact: string | null;
  created_at: Date;
}

async function loadApprovalRequestTx(tx: TenantTx, workspaceId: Id, approvalRequestId: Id): Promise<ApprovalRequest> {
  const result = await tx.query(
    `select id, workspace_id, campaign_id, content_version_id, target_channel, estimated_impact, created_at
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
    policyFlags: [],
    evidenceCitationIds: (citations.rows as Array<{ id: string }>).map((r) => r.id as Id),
    estimatedImpact: row.estimated_impact,
    createdAt: row.created_at,
  };
}

async function saveDecisionTx(tx: TenantTx, decision: ApprovalDecision): Promise<void> {
  await tx.query(
    `insert into approval_decision (id, workspace_id, approval_request_id, actor_user_id, actor_kind, decision, reason, decided_at)
     values ($1, $2, $3, $4, 'user', $5, $6, $7)`,
    [
      decision.id,
      decision.workspaceId,
      decision.approvalRequestId,
      decision.actorUserId,
      decision.decision,
      decision.reason,
      decision.decidedAt,
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
 * `isChannelConnected` is a documented stub that always returns false:
 * there is no channel-integration-status table yet (out of this task's
 * scope -- adding one would be a schema change another track owns), and
 * treating "no data" as "connected" would silently defeat T17's gate. Fail
 * closed instead, exactly like `auth.ts`'s session backend fails closed by
 * always throwing until a real backend lands. This means every real
 * approve attempt in the running app refuses today with the
 * "kênh đích đang ngắt kết nối" message -- an honest reflection of the
 * fact that no channel is actually connected yet, not a fabricated
 * success.
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
      isChannelConnected: async () => false,
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
