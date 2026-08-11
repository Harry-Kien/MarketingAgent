import type pg from "pg";
import type { Id } from "@smos/domain";
import { withTenant } from "./tenant-scope.ts";

export interface AuditTraceEvent {
  eventType: string;
  actorKind: string;
  occurredAt: Date;
}

export interface TraceChain {
  publicationId: Id;
  approvalDecisionId: Id;
  approvalRequestId: Id;
  contentVersionId: Id;
  contentItemId: Id;
  campaignId: Id;
  goalId: Id;
  auditEvents: AuditTraceEvent[];
}

interface ChainRow {
  publication_id: string;
  approval_decision_id: string;
  approval_request_id: string;
  content_version_id: string;
  content_item_id: string;
  campaign_id: string;
  goal_id: string;
}

interface AuditRow {
  event_type: string;
  actor_kind: string;
  occurred_at: Date;
}

/**
 * E12: given a publication id, walk the whole chain back to the business
 * goal that produced it --
 *
 *   publication -> approval_decision -> approval_request
 *   publication -> content_version -> content_item -> campaign -> goal
 *
 * plus every audit_log row attached to any id in that chain
 * (audit_log.subject_id), in chronological order. This is the audit claim
 * the milestone rests on: any external action can be traced to the decision
 * that authorised it.
 *
 * Runs entirely inside withTenant's scope, so every table read here is
 * already filtered to `workspaceId` by RLS (ENABLE + FORCE ROW LEVEL
 * SECURITY, every policy in infra/migrations). A publication belonging to
 * another workspace is therefore invisible to the very first join, exactly
 * like a publication id that does not exist at all -- there is no
 * "exists but belongs to someone else" branch for an error message to leak
 * (T6, no existence leak). Each join ALSO carries `workspace_id` explicitly,
 * on top of RLS: 0008_composite_tenant_fk.sql's composite foreign keys
 * (id, workspace_id) already make it structurally impossible for a child row
 * to reference a parent in a different workspace, so this is defense in
 * depth -- consistent with how 0008/0009 write every join predicate in this
 * chain -- and it keeps the query correct even run through a connection that
 * does not enforce RLS.
 */
export async function traceToGoal(pool: pg.Pool, workspaceId: Id, publicationId: Id): Promise<TraceChain> {
  return withTenant(pool, workspaceId, async (tx) => {
    const chainResult = await tx.query(
      `select
         p.id                  as publication_id,
         p.approval_decision_id,
         ad.approval_request_id,
         p.content_version_id,
         cv.content_item_id,
         ci.campaign_id,
         c.goal_id
       from publication p
       join approval_decision ad
         on ad.id = p.approval_decision_id and ad.workspace_id = p.workspace_id
       join content_version cv
         on cv.id = p.content_version_id and cv.workspace_id = p.workspace_id
       join content_item ci
         on ci.id = cv.content_item_id and ci.workspace_id = p.workspace_id
       join campaign c
         on c.id = ci.campaign_id and c.workspace_id = p.workspace_id
       where p.id = $1
         and p.workspace_id = $2`,
      [publicationId, workspaceId],
    );

    const row = chainResult.rows[0] as ChainRow | undefined;
    if (!row) {
      // Deliberately generic, and deliberately does NOT echo publicationId
      // back: whether the id does not exist anywhere, or exists but belongs
      // to another workspace (RLS hides it before this query ever sees it),
      // the caller gets byte-identical text either way. Interpolating the id
      // into the message would not itself prove existence (the caller
      // already supplied it), but a fixed message is the simplest way to
      // guarantee the two cases can never diverge by accident later.
      throw new Error("Publication not found");
    }

    const chainIds = [
      row.publication_id,
      row.approval_decision_id,
      row.approval_request_id,
      row.content_version_id,
      row.content_item_id,
      row.campaign_id,
      row.goal_id,
    ];

    const auditResult = await tx.query(
      `select event_type, actor_kind, occurred_at
       from audit_log
       where workspace_id = $1
         and subject_id = any($2::uuid[])
       order by occurred_at asc`,
      [workspaceId, chainIds],
    );

    return {
      publicationId: row.publication_id as Id,
      approvalDecisionId: row.approval_decision_id as Id,
      approvalRequestId: row.approval_request_id as Id,
      contentVersionId: row.content_version_id as Id,
      contentItemId: row.content_item_id as Id,
      campaignId: row.campaign_id as Id,
      goalId: row.goal_id as Id,
      auditEvents: (auditResult.rows as AuditRow[]).map((a) => ({
        eventType: a.event_type,
        actorKind: a.actor_kind,
        occurredAt: a.occurred_at,
      })),
    };
  });
}
