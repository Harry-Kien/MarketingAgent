// Late-review CRITICAL 1: "an approval can be retargeted after the decision,
// so unapproved content publishes under a genuine human approval".
//
// The reviewer's exact reproduction, run here as `smos_app` (never the
// migration role, never a mock): approve v1, create a revised content
// version v2, then
//
//   update approval_request set content_version_id = $v2 where id = $arId
//
// ...and publish v2. That UPDATE succeeded, because 0007_approval.sql grants
// smos_app UPDATE on approval_request and nothing froze the row once a
// decision existed. handlePublish's `decision.contentVersionId !==
// pub.contentVersionId` check reads that same mutable column through a join,
// so after the retarget it compared v2 to v2 and passed. `target_channel`
// was equally mutable: approve for meta_page, publish to tiktok_account.
//
// Every column of approval_request is probed below, not just the two the
// reviewer named -- the row as a whole is the record of WHAT a human was
// shown when they decided, and 0027_agent_run_immutable_when_terminal.sql
// already established that hand-enumerating a column list is exactly the
// shape of gap that gets under-scoped.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@smos/domain";
import { createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const adminPool = createDbPool(adminUrl);

const workspaceId = newId();
const userId = newId();
let campaignId: string;
let contentItemId: string;
let versionV1: string;
let versionV2: string;

async function seedRequest(contentVersionId: string, targetChannel = "meta_page"): Promise<string> {
  const id = newId();
  await withTenant(pool, workspaceId, (tx) =>
    tx.query(
      `insert into approval_request (id, workspace_id, campaign_id, content_version_id, target_channel, policy_flags, estimated_impact)
       values ($1, $2, $3, $4, $5, '[]'::jsonb, 'reach ~1.000')`,
      [id, workspaceId, campaignId, contentVersionId, targetChannel],
    ),
  );
  return id;
}

async function decide(approvalRequestId: string, contentVersionId: string, targetChannel = "meta_page"): Promise<string> {
  const id = newId();
  await withTenant(pool, workspaceId, (tx) =>
    tx.query(
      `insert into approval_decision (id, workspace_id, approval_request_id, actor_user_id, decision, reason, content_version_id, target_channel)
       values ($1, $2, $3, $4, 'approve', 'Đã rà soát và đồng ý đăng.', $5, $6)`,
      [id, workspaceId, approvalRequestId, userId, contentVersionId, targetChannel],
    ),
  );
  return id;
}

beforeAll(async () => {
  await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [
    workspaceId,
    `approval-frozen-${workspaceId}`,
  ]);
  await adminPool.query(`insert into user_account (id, email, name) values ($1, $2, $3)`, [
    userId,
    `approval-frozen-${workspaceId}@test.local`,
    "Người sáng lập",
  ]);
  const goalId = newId();
  await adminPool.query(`insert into goal (id, workspace_id, statement) values ($1, $2, 'approval frozen probe')`, [
    goalId,
    workspaceId,
  ]);
  campaignId = newId();
  await adminPool.query(
    `insert into campaign (id, workspace_id, goal_id, name, state) values ($1, $2, $3, $4, 'WAITING_APPROVAL')`,
    [campaignId, workspaceId, goalId, `approval-frozen-campaign-${campaignId}`],
  );
  contentItemId = newId();
  versionV1 = newId();
  versionV2 = newId();
  await withTenant(pool, workspaceId, async (tx) => {
    await tx.query(`insert into content_item (id, workspace_id, campaign_id, kind, title) values ($1,$2,$3,'social_post',$4)`, [
      contentItemId,
      workspaceId,
      campaignId,
      `approval-frozen-item-${contentItemId}`,
    ]);
    await tx.query(
      `insert into content_version (id, workspace_id, content_item_id, version_number, body, publication_content)
       values ($1,$2,$3,1,'v1 body','v1 publication')`,
      [versionV1, workspaceId, contentItemId],
    );
    await tx.query(
      `insert into content_version (id, workspace_id, content_item_id, version_number, body, publication_content)
       values ($1,$2,$3,2,'v2 body','v2 publication chưa từng được duyệt')`,
      [versionV2, workspaceId, contentItemId],
    );
  });
});

afterAll(async () => {
  // approval_decision and audit_log are append-only for every role, so the
  // rows this file creates below them (approval_request, content_version,
  // content_item, campaign, goal, workspace, user_account) are pinned in
  // place too -- exactly the convention cross-tenant.test.ts and
  // apps/web/e2e/fixtures/seed.ts already document. Every id here comes from
  // newId(), so what is left behind can never collide with a later run.
  await pool.end();
  await adminPool.end();
});

describe("approval_request is frozen once a decision exists (CRITICAL 1)", () => {
  it("refuses the reviewer's retarget: content_version_id may not move to an un-approved version", async () => {
    const arId = await seedRequest(versionV1);
    await decide(arId, versionV1);

    await expect(
      withTenant(pool, workspaceId, (tx) =>
        tx.query(`update approval_request set content_version_id = $1 where id = $2`, [versionV2, arId]),
      ),
    ).rejects.toThrow(/decided|immutable|violates/i);

    const after = await adminPool.query(`select content_version_id from approval_request where id = $1`, [arId]);
    expect(after.rows[0].content_version_id).toBe(versionV1);
  });

  it("refuses retargeting target_channel after the decision (approve meta_page, publish tiktok_account)", async () => {
    const arId = await seedRequest(versionV1);
    await decide(arId, versionV1);

    await expect(
      withTenant(pool, workspaceId, (tx) =>
        tx.query(`update approval_request set target_channel = 'tiktok_account' where id = $1`, [arId]),
      ),
    ).rejects.toThrow(/decided|immutable|violates/i);

    const after = await adminPool.query(`select target_channel from approval_request where id = $1`, [arId]);
    expect(after.rows[0].target_channel).toBe("meta_page");
  });

  it.each([
    ["campaign_id", `campaign_id = gen_random_uuid()`],
    ["policy_flags", `policy_flags = '[{"code":"x","severity":"info","message":"m"}]'::jsonb`],
    ["estimated_impact", `estimated_impact = 'reach ~9.999.999'`],
    ["created_at", `created_at = now() - interval '90 days'`],
    ["id", `id = gen_random_uuid()`],
    ["workspace_id", `workspace_id = gen_random_uuid()`],
  ])("refuses changing %s after the decision", async (_column, setClause) => {
    const arId = await seedRequest(versionV1);
    await decide(arId, versionV1);

    await expect(
      withTenant(pool, workspaceId, (tx) => tx.query(`update approval_request set ${setClause} where id = $1`, [arId])),
    ).rejects.toThrow(/decided|immutable|violates|denied/i);
  });

  it("still allows editing a request that has NOT been decided yet", async () => {
    const arId = await seedRequest(versionV1);
    await withTenant(pool, workspaceId, (tx) =>
      tx.query(`update approval_request set estimated_impact = 'reach ~2.000' where id = $1`, [arId]),
    );
    const after = await adminPool.query(`select estimated_impact from approval_request where id = $1`, [arId]);
    expect(after.rows[0].estimated_impact).toBe("reach ~2.000");
  });

  it("permits a no-op UPDATE on a decided request (0023's precedent: identical row, no refusal)", async () => {
    const arId = await seedRequest(versionV1);
    await decide(arId, versionV1);
    await withTenant(pool, workspaceId, (tx) =>
      tx.query(`update approval_request set target_channel = target_channel where id = $1`, [arId]),
    );
  });
});

describe("approval_decision records WHAT was approved, independently of the request (CRITICAL 1, lock 2)", () => {
  it("refuses a decision whose recorded content_version_id disagrees with its request", async () => {
    const arId = await seedRequest(versionV1);
    await expect(decide(arId, versionV2)).rejects.toThrow(/foreign key|violates/i);
  });

  it("refuses a decision whose recorded target_channel disagrees with its request", async () => {
    const arId = await seedRequest(versionV1);
    await expect(decide(arId, versionV1, "tiktok_account")).rejects.toThrow(/foreign key|violates/i);
  });

  it("records the approved content version and channel on the immutable decision row itself", async () => {
    const arId = await seedRequest(versionV1);
    const decisionId = await decide(arId, versionV1);
    const r = await adminPool.query(
      `select content_version_id, target_channel from approval_decision where id = $1`,
      [decisionId],
    );
    expect(r.rows[0].content_version_id).toBe(versionV1);
    expect(r.rows[0].target_channel).toBe("meta_page");
  });
});
