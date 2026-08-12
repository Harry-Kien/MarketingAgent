import { afterAll, describe, expect, it } from "vitest";
import { createDbPool } from "@smos/db";
import { seedTwoWorkspaces } from "@smos/testing";
import { getCampaign, getTodayBoard } from "./queries.ts";

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
});
