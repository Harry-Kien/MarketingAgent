// E7 fixture: seeds a real, log-in-able workspace for the Playwright suite
// (apps/web/e2e/auth.spec.ts). Distinct from seed.ts's `seedWorkspace`
// (which inserts a bare user_account row with no credential and no
// workspace_member -- there was nothing to log in with before this task)
// but reuses seed.ts's other helpers, which only need the same four
// GoldenWorkspace fields.
import type pg from "pg";
import { newId, createCampaign, type Id } from "@smos/domain";
import { adminAuth } from "../../src/server/auth-admin.ts";
import type { GoldenWorkspace } from "./seed.ts";

const GOAL_STATEMENT = "Tăng nhận diện thương hiệu cho sản phẩm mới trong quý này";

export interface AuthSeededWorkspace extends GoldenWorkspace {
  email: string;
  password: string;
  campaignName: string;
}

/**
 * Provisions a real user via the admin-mode, sign-up-enabled better-auth
 * instance (apps/web/src/server/auth-admin.ts) -- the same administrative
 * path 0030_user_account_no_app_write.sql requires, since smos_app (what
 * the running app itself connects as) can never INSERT into user_account.
 * Password is synthetic and unique per call (`newId()`), never a fixed
 * literal.
 */
export async function seedWorkspaceWithLogin(adminPool: pg.Pool, label: string): Promise<AuthSeededWorkspace> {
  const workspaceId = newId();
  const goalId = newId();
  const email = `e2e-auth-${label}-${newId()}@test.local`;
  const password = `Test-Pw-${newId()}!`;

  await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [
    workspaceId,
    `e2e-auth-${label}-${workspaceId}`,
  ]);

  const signUpResult = await adminAuth.api.signUpEmail({ body: { email, password, name: label } });
  const userId = signUpResult.user.id as Id;

  await adminPool.query(`insert into workspace_member (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`, [
    newId(),
    workspaceId,
    userId,
  ]);

  await adminPool.query(`insert into goal (id, workspace_id, statement) values ($1, $2, $3)`, [
    goalId,
    workspaceId,
    GOAL_STATEMENT,
  ]);

  const { campaign } = createCampaign({
    workspaceId,
    goalId,
    name: `E2E Auth ${workspaceId}`,
    actor: { kind: "system", reason: "e2e auth fixture seed" },
    correlationId: newId(),
  });
  await adminPool.query(
    `insert into campaign (id, workspace_id, goal_id, name, state, version) values ($1, $2, $3, $4, $5, $6)`,
    [campaign.id, workspaceId, goalId, campaign.name, campaign.state, campaign.version],
  );

  return { workspaceId, userId, goalId, campaignId: campaign.id, email, password, campaignName: campaign.name };
}

/** workspace_member has no children and no immutability trigger, so it is
 * always safely deletable -- unlike goal/campaign/user_account, which this
 * intentionally leaves in place, matching seed.ts's own cleanupWorkspace
 * convention (every id is newId()-suffixed, so leftover rows never collide
 * with a later run). */
export async function cleanupAuthWorkspace(adminPool: pg.Pool, ws: AuthSeededWorkspace): Promise<void> {
  await adminPool.query(`delete from workspace_member where workspace_id = $1`, [ws.workspaceId]).catch(() => undefined);
}
