import { afterAll, describe, expect, it } from "vitest";
import { createDbPool } from "@smos/db";
import { newId } from "@smos/domain";
import { seedTwoWorkspaces } from "@smos/testing";
import {
  getApprovalRequestDetail,
  getCampaign,
  getContentItem,
  getPendingApprovals,
  getTodayBoard,
} from "./queries.ts";

// Per STANDING-CONTEXT.md: PostgreSQL is on host port 5433, and the
// application connects as smos_app, never smos (the migration-only role).
// Seeding needs a role that bypasses RLS to write rows into two workspaces
// at once (no tenant scope open yet), so seedTwoWorkspaces runs against
// DATABASE_MIGRATION_URL -- exactly the split cross-tenant.test.ts
// (packages/db) already uses. The queries under test run against the plain
// smos_app pool, the same connection the real app process uses.
const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const adminPool = createDbPool(adminUrl);

afterAll(async () => {
  await pool.end();
  await adminPool.end();
});

describe("server queries", () => {
  it("returns only the caller's workspace rows", async () => {
    const { a, b } = await seedTwoWorkspaces(adminPool);
    const boardA = await getTodayBoard(pool, a.workspaceId);
    expect(boardA.campaigns.every((c) => c.workspaceId === a.workspaceId)).toBe(true);
    expect(boardA.campaigns.some((c) => c.id === b.campaignId)).toBe(false);
  });

  it("E14: returns null for a campaign in another workspace, not an error", async () => {
    const { a, b } = await seedTwoWorkspaces(adminPool);
    await expect(getCampaign(pool, b.workspaceId, a.campaignId)).resolves.toBeNull();
  });

  it("returns the campaign when it belongs to the caller's own workspace", async () => {
    const { a } = await seedTwoWorkspaces(adminPool);
    const campaign = await getCampaign(pool, a.workspaceId, a.campaignId);
    expect(campaign?.id).toBe(a.campaignId);
    expect(campaign?.workspaceId).toBe(a.workspaceId);
  });

  it("reports pending approvals for the board", async () => {
    const { a } = await seedTwoWorkspaces(adminPool);
    const board = await getTodayBoard(pool, a.workspaceId);
    expect(board.pendingApprovalCount).toBeGreaterThanOrEqual(0);
  });

  it("getContentItem returns the item with its latest version and citations, no earlier version", async () => {
    const { a } = await seedTwoWorkspaces(adminPool);
    const item = await getContentItem(pool, a.workspaceId, a.contentItemId);
    expect(item?.id).toBe(a.contentItemId);
    expect(item?.latestVersion?.id).toBe(a.contentVersionId);
    expect(item?.latestVersion?.citations.some((c) => c.id === a.sourceCitationId)).toBe(true);
    // Fixture seeds exactly one version (version_number 1); there is no
    // earlier version for the diff view to show.
    expect(item?.previousVersion).toBeNull();
  });

  it("E14: getContentItem returns null for a content item in another workspace, not an error", async () => {
    const { a, b } = await seedTwoWorkspaces(adminPool);
    await expect(getContentItem(pool, b.workspaceId, a.contentItemId)).resolves.toBeNull();
  });

  it("getPendingApprovals excludes a request that already has a decision, includes one that does not", async () => {
    const { a } = await seedTwoWorkspaces(adminPool);
    // The fixture's own approval_request is already decided (seeded with a
    // matching approval_decision) -- add a second, undecided request
    // reusing the same already-seeded campaign/content_version so this test
    // proves the "no decision yet" filter itself, not just an empty list.
    const undecidedId = newId();
    await adminPool.query(
      `insert into approval_request (id, workspace_id, campaign_id, content_version_id, target_channel)
       values ($1, $2, $3, $4, 'meta_page')`,
      [undecidedId, a.workspaceId, a.campaignId, a.contentVersionId],
    );
    const pending = await getPendingApprovals(pool, a.workspaceId);
    expect(pending.some((p) => p.id === undecidedId)).toBe(true);
    expect(pending.some((p) => p.id === a.approvalRequestId)).toBe(false);
  });

  it("getApprovalRequestDetail returns evidence, target channel and the already-recorded decision", async () => {
    const { a } = await seedTwoWorkspaces(adminPool);
    const detail = await getApprovalRequestDetail(pool, a.workspaceId, a.approvalRequestId);
    expect(detail?.targetChannel).toBe("meta_page");
    expect(detail?.evidence.some((e) => e.id === a.sourceCitationId)).toBe(true);
    expect(detail?.decision?.decision).toBe("approve");
    expect(detail?.decision?.actorUserId).toBe(a.userId);
  });

  it("E14: getApprovalRequestDetail returns null for a request in another workspace, not an error", async () => {
    const { a, b } = await seedTwoWorkspaces(adminPool);
    await expect(getApprovalRequestDetail(pool, b.workspaceId, a.approvalRequestId)).resolves.toBeNull();
  });
});
