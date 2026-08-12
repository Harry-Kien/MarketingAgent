import type pg from "pg";
import type { Id, LifecycleState } from "@smos/domain";
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
