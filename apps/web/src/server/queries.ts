import type pg from "pg";
import type { ContentKind, Id, LifecycleState, VerificationStatus } from "@smos/domain";
import { withTenant } from "@smos/db";

export interface BoardCampaign {
  id: Id;
  workspaceId: Id;
  name: string;
  state: LifecycleState;
  updatedAt: Date;
}

export interface TodayBoard {
  campaigns: BoardCampaign[];
  pendingApprovalCount: number;
}

interface CampaignRow {
  id: string;
  workspace_id: string;
  name: string;
  state: string;
  updated_at: Date;
}

/**
 * The "Sổ điều hành" (operating brief) board: every campaign in the caller's
 * workspace, plus the count of approval requests still waiting on a
 * decision. `workspaceId` must already be resolved server-side (see
 * `requireWorkspace()`, `apps/web/src/server/auth.ts`) -- this function
 * never accepts one from a route parameter, query string, header or body,
 * and everything it reads goes through `withTenant`, so RLS confines the
 * result to one workspace even if this SQL had a bug.
 */
export async function getTodayBoard(pool: pg.Pool, workspaceId: Id): Promise<TodayBoard> {
  return withTenant(pool, workspaceId, async (tx) => {
    const campaignsResult = await tx.query(
      `select id, workspace_id, name, state, updated_at
       from campaign
       where workspace_id = $1
       order by updated_at desc`,
      [workspaceId],
    );

    // Pending = an approval_request with no matching approval_decision yet.
    // approval_decision.approval_request_id is UNIQUE (0007_approval.sql),
    // so this left join can only ever add zero or one row per request.
    const pendingResult = await tx.query(
      `select count(*)::int as count
       from approval_request ar
       left join approval_decision ad
         on ad.approval_request_id = ar.id and ad.workspace_id = ar.workspace_id
       where ar.workspace_id = $1
         and ad.id is null`,
      [workspaceId],
    );

    const rows = campaignsResult.rows as CampaignRow[];
    return {
      campaigns: rows.map((row) => ({
        id: row.id as Id,
        workspaceId: row.workspace_id as Id,
        name: row.name,
        state: row.state as LifecycleState,
        updatedAt: row.updated_at,
      })),
      pendingApprovalCount: Number((pendingResult.rows[0] as { count: number } | undefined)?.count ?? 0),
    };
  });
}

export interface CampaignDetail {
  id: Id;
  workspaceId: Id;
  goalId: Id;
  name: string;
  state: LifecycleState;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface CampaignDetailRow {
  id: string;
  workspace_id: string;
  goal_id: string;
  name: string;
  state: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * E14: a campaign id that belongs to another workspace must read exactly
 * like one that does not exist at all -- `null`, never an error and never a
 * different message, so a caller can't distinguish "wrong workspace" from
 * "no such campaign" by probing. RLS already guarantees this (the row is
 * invisible before this query's own `and workspace_id = $2` even runs); the
 * explicit predicate is defense in depth, matching the style already used in
 * `packages/db/src/audit-trace.ts`'s `traceToGoal`.
 */
export async function getCampaign(
  pool: pg.Pool,
  workspaceId: Id,
  campaignId: Id,
): Promise<CampaignDetail | null> {
  return withTenant(pool, workspaceId, async (tx) => {
    const result = await tx.query(
      `select id, workspace_id, goal_id, name, state, version, created_at, updated_at
       from campaign
       where id = $1
         and workspace_id = $2`,
      [campaignId, workspaceId],
    );
    const row = result.rows[0] as CampaignDetailRow | undefined;
    if (!row) return null;
    return {
      id: row.id as Id,
      workspaceId: row.workspace_id as Id,
      goalId: row.goal_id as Id,
      name: row.name,
      state: row.state as LifecycleState,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export interface CitationView {
  id: Id;
  url: string;
  accessedAt: Date;
  excerpt: string;
  verificationStatus: VerificationStatus;
}

export interface ContentVersionView {
  id: Id;
  versionNumber: number;
  body: string;
  publicationContent: string | null;
  qualityScore: number | null;
  createdAt: Date;
  citations: CitationView[];
}

export interface ContentItemDetail {
  id: Id;
  workspaceId: Id;
  campaignId: Id;
  kind: ContentKind;
  title: string;
  latestVersion: ContentVersionView | null;
  previousVersion: ContentVersionView | null;
}

interface CitationRow {
  id: string;
  content_version_id: string;
  url: string;
  accessed_at: Date;
  excerpt: string;
  verification_status: string;
}

/**
 * Content Studio's data: a content item, its latest version (what's about
 * to be published), and the version immediately before it (so the page can
 * show a before/after diff -- `null` for both fields the diff needs when
 * there is no earlier version yet, not a fabricated empty string). Citations
 * come back attached to whichever version they belong to, never merged
 * across versions.
 */
export async function getContentItem(
  pool: pg.Pool,
  workspaceId: Id,
  contentItemId: Id,
): Promise<ContentItemDetail | null> {
  return withTenant(pool, workspaceId, async (tx) => {
    const itemResult = await tx.query(
      `select id, workspace_id, campaign_id, kind, title
       from content_item
       where id = $1 and workspace_id = $2`,
      [contentItemId, workspaceId],
    );
    const itemRow = itemResult.rows[0] as
      | { id: string; workspace_id: string; campaign_id: string; kind: string; title: string }
      | undefined;
    if (!itemRow) return null;

    const versionsResult = await tx.query(
      `select id, content_item_id, version_number, body, publication_content, quality_score, created_at
       from content_version
       where content_item_id = $1 and workspace_id = $2
       order by version_number desc
       limit 2`,
      [contentItemId, workspaceId],
    );
    const versionRows = versionsResult.rows as Array<{
      id: string;
      version_number: number;
      body: string;
      publication_content: string | null;
      quality_score: number | null;
      created_at: Date;
    }>;

    const versionIds = versionRows.map((v) => v.id);
    const citationsByVersion = new Map<string, CitationView[]>();
    if (versionIds.length > 0) {
      const citationsResult = await tx.query(
        `select id, content_version_id, url, accessed_at, excerpt, verification_status
         from source_citation
         where content_version_id = any($1::uuid[]) and workspace_id = $2`,
        [versionIds, workspaceId],
      );
      for (const row of citationsResult.rows as CitationRow[]) {
        const list = citationsByVersion.get(row.content_version_id) ?? [];
        list.push({
          id: row.id as Id,
          url: row.url,
          accessedAt: row.accessed_at,
          excerpt: row.excerpt,
          verificationStatus: row.verification_status as VerificationStatus,
        });
        citationsByVersion.set(row.content_version_id, list);
      }
    }

    const toView = (row: (typeof versionRows)[number] | undefined): ContentVersionView | null =>
      row === undefined
        ? null
        : {
            id: row.id as Id,
            versionNumber: row.version_number,
            body: row.body,
            publicationContent: row.publication_content,
            qualityScore: row.quality_score,
            createdAt: row.created_at,
            citations: citationsByVersion.get(row.id) ?? [],
          };

    return {
      id: itemRow.id as Id,
      workspaceId: itemRow.workspace_id as Id,
      campaignId: itemRow.campaign_id as Id,
      kind: itemRow.kind as ContentKind,
      title: itemRow.title,
      latestVersion: toView(versionRows[0]),
      previousVersion: toView(versionRows[1]),
    };
  });
}

export interface PendingApprovalSummary {
  id: Id;
  campaignId: Id;
  targetChannel: string;
  createdAt: Date;
}

/**
 * Approval Center's list: every approval_request in this workspace with no
 * recorded decision yet -- the same "no matching approval_decision" join
 * `getTodayBoard` counts, here returning the rows themselves.
 */
export async function getPendingApprovals(pool: pg.Pool, workspaceId: Id): Promise<PendingApprovalSummary[]> {
  return withTenant(pool, workspaceId, async (tx) => {
    const result = await tx.query(
      `select ar.id, ar.campaign_id, ar.target_channel, ar.created_at
       from approval_request ar
       left join approval_decision ad
         on ad.approval_request_id = ar.id and ad.workspace_id = ar.workspace_id
       where ar.workspace_id = $1
         and ad.id is null
       order by ar.created_at asc`,
      [workspaceId],
    );
    return (
      result.rows as Array<{ id: string; campaign_id: string; target_channel: string; created_at: Date }>
    ).map((row) => ({
      id: row.id as Id,
      campaignId: row.campaign_id as Id,
      targetChannel: row.target_channel,
      createdAt: row.created_at,
    }));
  });
}

export interface PolicyFlagView {
  ruleId: string;
  ruleVersion: number;
  severity: "info" | "warn" | "block";
  message: string;
}

export interface ApprovalDecisionView {
  decision: string;
  reason: string;
  decidedAt: Date;
  actorUserId: Id;
}

export interface ApprovalRequestDetail {
  id: Id;
  workspaceId: Id;
  campaignId: Id;
  contentVersionId: Id;
  targetChannel: string;
  policyFlags: PolicyFlagView[];
  estimatedImpact: string | null;
  createdAt: Date;
  evidence: CitationView[];
  content: { body: string; publicationContent: string | null; previousPublicationContent: string | null };
  decision: ApprovalDecisionView | null;
}

/**
 * Everything the Approval Center's detail page needs to render honestly:
 * the diff (current vs. previous publication_content), every citation with
 * its URL and access date, policy flags carrying `ruleId`/`ruleVersion`,
 * the resolved target channel, and -- if this request has already been
 * decided -- the recorded decision, so a founder revisiting an old approval
 * sees what actually happened instead of a re-armed approve button.
 */
export async function getApprovalRequestDetail(
  pool: pg.Pool,
  workspaceId: Id,
  approvalRequestId: Id,
): Promise<ApprovalRequestDetail | null> {
  return withTenant(pool, workspaceId, async (tx) => {
    const requestResult = await tx.query(
      `select id, workspace_id, campaign_id, content_version_id, target_channel, policy_flags, estimated_impact, created_at
       from approval_request
       where id = $1 and workspace_id = $2`,
      [approvalRequestId, workspaceId],
    );
    const reqRow = requestResult.rows[0] as
      | {
          id: string;
          workspace_id: string;
          campaign_id: string;
          content_version_id: string;
          target_channel: string;
          policy_flags: PolicyFlagView[] | null;
          estimated_impact: string | null;
          created_at: Date;
        }
      | undefined;
    if (!reqRow) return null;

    const versionResult = await tx.query(
      `select cv.body, cv.publication_content, cv.content_item_id, cv.version_number
       from content_version cv
       where cv.id = $1 and cv.workspace_id = $2`,
      [reqRow.content_version_id, workspaceId],
    );
    const versionRow = versionResult.rows[0] as
      | { body: string; publication_content: string | null; content_item_id: string; version_number: number }
      | undefined;

    let previousPublicationContent: string | null = null;
    if (versionRow && versionRow.version_number > 1) {
      const prevResult = await tx.query(
        `select publication_content
         from content_version
         where content_item_id = $1 and workspace_id = $2 and version_number = $3`,
        [versionRow.content_item_id, workspaceId, versionRow.version_number - 1],
      );
      previousPublicationContent =
        (prevResult.rows[0] as { publication_content: string | null } | undefined)?.publication_content ?? null;
    }

    const citationsResult = await tx.query(
      `select id, url, accessed_at, excerpt, verification_status
       from source_citation
       where content_version_id = $1 and workspace_id = $2
       order by accessed_at asc`,
      [reqRow.content_version_id, workspaceId],
    );
    const evidence = (
      citationsResult.rows as Array<{
        id: string;
        url: string;
        accessed_at: Date;
        excerpt: string;
        verification_status: string;
      }>
    ).map((row) => ({
      id: row.id as Id,
      url: row.url,
      accessedAt: row.accessed_at,
      excerpt: row.excerpt,
      verificationStatus: row.verification_status as VerificationStatus,
    }));

    const decisionResult = await tx.query(
      `select decision, reason, decided_at, actor_user_id
       from approval_decision
       where approval_request_id = $1 and workspace_id = $2`,
      [approvalRequestId, workspaceId],
    );
    const decisionRow = decisionResult.rows[0] as
      | { decision: string; reason: string; decided_at: Date; actor_user_id: string }
      | undefined;

    return {
      id: reqRow.id as Id,
      workspaceId: reqRow.workspace_id as Id,
      campaignId: reqRow.campaign_id as Id,
      contentVersionId: reqRow.content_version_id as Id,
      targetChannel: reqRow.target_channel,
      policyFlags: reqRow.policy_flags ?? [],
      estimatedImpact: reqRow.estimated_impact,
      createdAt: reqRow.created_at,
      evidence,
      content: {
        body: versionRow?.body ?? "",
        publicationContent: versionRow?.publication_content ?? null,
        previousPublicationContent,
      },
      decision: decisionRow
        ? {
            decision: decisionRow.decision,
            reason: decisionRow.reason,
            decidedAt: decisionRow.decided_at,
            actorUserId: decisionRow.actor_user_id as Id,
          }
        : null,
    };
  });
}
