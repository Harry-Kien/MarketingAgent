// Fix round 1 on Task 8. Adversarial review reproduced live: a session
// scoped to workspace B could insert an approval_decision with
// workspace_id = B that referenced an approval_request belonging to
// workspace A. PostgreSQL evaluates foreign keys against the referenced
// table with RLS bypassed entirely, so a single-column FK on
// approval_request_id never checked that the two rows agreed on
// workspace_id -- and because approval_request_id is UNIQUE, the hijacked
// row permanently occupied the slot, denying workspace A's real user the
// ability to ever record a decision on their own request.
//
// The same hole exists on every foreign key between two workspace-owned
// tables (infra/migrations/0008_composite_tenant_fk.sql fixes all seven):
//   campaign.goal_id                    -> goal
//   content_item.campaign_id            -> campaign
//   content_version.content_item_id     -> content_item
//   source_citation.content_version_id  -> content_version
//   approval_request.campaign_id        -> campaign
//   approval_request.content_version_id -> content_version
//   approval_decision.approval_request_id -> approval_request
//
// This file proves, for each pair: (a) a cross-workspace reference is
// refused, and (b) a same-workspace reference still works (the composite
// FK has not broken normal operation).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);

const adminUrl =
  process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);

const A = "12121212-1212-7212-8212-121212121212";
const B = "34343434-3434-7343-8343-343434343434";

interface Chain {
  goalId: string;
  campaignId: string;
  contentItemId: string;
  contentVersionId: string;
  approvalRequestId: string;
}

const chains: Record<string, Chain> = {};

async function seedChain(ws: string): Promise<Chain> {
  return withTenant(pool, ws, async (tx) => {
    const goal = await tx.query(
      `insert into goal (id, workspace_id, statement) values (gen_random_uuid(), $1, 'fk-hijack probe') returning id`,
      [ws],
    );
    const campaign = await tx.query(
      `insert into campaign (id, workspace_id, goal_id, name, state) values (gen_random_uuid(), $1, $2, $3, 'DRAFT') returning id`,
      [ws, goal.rows[0].id, `fk-hijack-campaign ${Date.now()}-${Math.random()}`],
    );
    const item = await tx.query(
      `insert into content_item (id, workspace_id, campaign_id, kind, title) values (gen_random_uuid(), $1, $2, 'social_post', $3) returning id`,
      [ws, campaign.rows[0].id, `fk-hijack-item ${Date.now()}-${Math.random()}`],
    );
    const version = await tx.query(
      `insert into content_version (id, workspace_id, content_item_id, version_number, body) values (gen_random_uuid(), $1, $2, 1, 'body') returning id`,
      [ws, item.rows[0].id],
    );
    const request = await tx.query(
      `insert into approval_request (id, workspace_id, campaign_id, content_version_id, target_channel) values (gen_random_uuid(), $1, $2, $3, 'meta_page') returning id`,
      [ws, campaign.rows[0].id, version.rows[0].id],
    );
    return {
      goalId: goal.rows[0].id as string,
      campaignId: campaign.rows[0].id as string,
      contentItemId: item.rows[0].id as string,
      contentVersionId: version.rows[0].id as string,
      approvalRequestId: request.rows[0].id as string,
    };
  });
}

async function seedUser(label: string): Promise<string> {
  const r = await adminPool.query(
    `insert into user_account (id,email,name) values (gen_random_uuid(),$1,$2) returning id`,
    [`${label}-${Date.now()}-${Math.random()}@test.local`, label],
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${A}::uuid, 'fk-hijack-A'), (${B}::uuid, 'fk-hijack-B') on conflict do nothing`,
  );
  chains[A] = await seedChain(A);
  chains[B] = await seedChain(B);
});

afterAll(async () => {
  await pool.end();
  await adminPool.end();
});

describe("campaign.goal_id -> goal", () => {
  it("refuses a campaign in workspace B pointing at workspace A's goal", async () => {
    await expect(
      withTenant(pool, B, (tx) =>
        tx.query(
          `insert into campaign (id, workspace_id, goal_id, name, state) values (gen_random_uuid(), $1, $2, $3, 'DRAFT')`,
          [B, chains[A]!.goalId, `hijack-campaign ${Date.now()}-${Math.random()}`],
        )),
    ).rejects.toThrow(/campaign_goal_id_workspace_fkey/);
  });

  it("still allows a campaign in workspace B pointing at workspace B's own goal", async () => {
    const result = await withTenant(pool, B, (tx) =>
      tx.query(
        `insert into campaign (id, workspace_id, goal_id, name, state) values (gen_random_uuid(), $1, $2, $3, 'DRAFT') returning id, goal_id`,
        [B, chains[B]!.goalId, `legit-campaign ${Date.now()}-${Math.random()}`],
      ));
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].goal_id).toBe(chains[B]!.goalId);
  });
});

describe("content_item.campaign_id -> campaign", () => {
  it("refuses a content_item in workspace B pointing at workspace A's campaign", async () => {
    await expect(
      withTenant(pool, B, (tx) =>
        tx.query(
          `insert into content_item (id, workspace_id, campaign_id, kind, title) values (gen_random_uuid(), $1, $2, 'social_post', $3)`,
          [B, chains[A]!.campaignId, `hijack-item ${Date.now()}-${Math.random()}`],
        )),
    ).rejects.toThrow(/content_item_campaign_id_workspace_fkey/);
  });

  it("still allows a content_item in workspace B pointing at workspace B's own campaign", async () => {
    const result = await withTenant(pool, B, (tx) =>
      tx.query(
        `insert into content_item (id, workspace_id, campaign_id, kind, title) values (gen_random_uuid(), $1, $2, 'social_post', $3) returning id, campaign_id`,
        [B, chains[B]!.campaignId, `legit-item ${Date.now()}-${Math.random()}`],
      ));
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].campaign_id).toBe(chains[B]!.campaignId);
  });
});

describe("content_version.content_item_id -> content_item", () => {
  it("refuses a content_version in workspace B pointing at workspace A's content_item", async () => {
    await expect(
      withTenant(pool, B, (tx) =>
        tx.query(
          `insert into content_version (id, workspace_id, content_item_id, version_number, body) values (gen_random_uuid(), $1, $2, 99, 'hijack body')`,
          [B, chains[A]!.contentItemId],
        )),
    ).rejects.toThrow(/content_version_content_item_id_workspace_fkey/);
  });

  it("still allows a content_version in workspace B pointing at workspace B's own content_item", async () => {
    const result = await withTenant(pool, B, (tx) =>
      tx.query(
        `insert into content_version (id, workspace_id, content_item_id, version_number, body) values (gen_random_uuid(), $1, $2, 99, 'legit body') returning id, content_item_id`,
        [B, chains[B]!.contentItemId],
      ));
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].content_item_id).toBe(chains[B]!.contentItemId);
  });
});

describe("source_citation.content_version_id -> content_version", () => {
  it("refuses a source_citation in workspace B pointing at workspace A's content_version", async () => {
    await expect(
      withTenant(pool, B, (tx) =>
        tx.query(
          `insert into source_citation (id, workspace_id, content_version_id, url, accessed_at, excerpt, verification_status) values (gen_random_uuid(), $1, $2, 'https://hijack.test', now(), 'x', 'VERIFIED')`,
          [B, chains[A]!.contentVersionId],
        )),
    ).rejects.toThrow(/source_citation_content_version_id_workspace_fkey/);
  });

  it("still allows a source_citation in workspace B pointing at workspace B's own content_version", async () => {
    const result = await withTenant(pool, B, (tx) =>
      tx.query(
        `insert into source_citation (id, workspace_id, content_version_id, url, accessed_at, excerpt, verification_status) values (gen_random_uuid(), $1, $2, 'https://legit.test', now(), 'x', 'VERIFIED') returning id, content_version_id`,
        [B, chains[B]!.contentVersionId],
      ));
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].content_version_id).toBe(chains[B]!.contentVersionId);
  });
});

describe("approval_request.campaign_id -> campaign", () => {
  it("refuses an approval_request in workspace B pointing at workspace A's campaign", async () => {
    await expect(
      withTenant(pool, B, (tx) =>
        tx.query(
          `insert into approval_request (id, workspace_id, campaign_id, content_version_id, target_channel) values (gen_random_uuid(), $1, $2, $3, 'meta_page')`,
          [B, chains[A]!.campaignId, chains[B]!.contentVersionId],
        )),
    ).rejects.toThrow(/approval_request_campaign_id_workspace_fkey/);
  });

  it("still allows an approval_request in workspace B pointing at workspace B's own campaign", async () => {
    const result = await withTenant(pool, B, (tx) =>
      tx.query(
        `insert into approval_request (id, workspace_id, campaign_id, content_version_id, target_channel) values (gen_random_uuid(), $1, $2, $3, 'meta_page') returning id, campaign_id`,
        [B, chains[B]!.campaignId, chains[B]!.contentVersionId],
      ));
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].campaign_id).toBe(chains[B]!.campaignId);
  });
});

describe("approval_request.content_version_id -> content_version", () => {
  it("refuses an approval_request in workspace B pointing at workspace A's content_version", async () => {
    await expect(
      withTenant(pool, B, (tx) =>
        tx.query(
          `insert into approval_request (id, workspace_id, campaign_id, content_version_id, target_channel) values (gen_random_uuid(), $1, $2, $3, 'meta_page')`,
          [B, chains[B]!.campaignId, chains[A]!.contentVersionId],
        )),
    ).rejects.toThrow(/approval_request_content_version_id_workspace_fkey/);
  });

  it("still allows an approval_request in workspace B pointing at workspace B's own content_version", async () => {
    const result = await withTenant(pool, B, (tx) =>
      tx.query(
        `insert into approval_request (id, workspace_id, campaign_id, content_version_id, target_channel) values (gen_random_uuid(), $1, $2, $3, 'meta_page') returning id, content_version_id`,
        [B, chains[B]!.campaignId, chains[B]!.contentVersionId],
      ));
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].content_version_id).toBe(chains[B]!.contentVersionId);
  });
});

describe("approval_decision.approval_request_id -> approval_request (the reported HIGH bug)", () => {
  it("refuses a decision in workspace B pointing at workspace A's approval_request", async () => {
    const userId = await seedUser("hijack-decision");
    await expect(
      withTenant(pool, B, (tx) =>
        tx.query(
          `insert into approval_decision (id, workspace_id, approval_request_id, actor_user_id, decision, reason) values (gen_random_uuid(), $1, $2, $3, 'approve', 'hijacked')`,
          [B, chains[A]!.approvalRequestId, userId],
        )),
    ).rejects.toThrow(/approval_decision_approval_request_id_workspace_fkey/);
  });

  it("still allows a decision in workspace B pointing at workspace B's own approval_request", async () => {
    const userId = await seedUser("legit-decision");
    // Fresh request: chains[B].approvalRequestId may already carry a
    // decision from an earlier test run against this persistent database.
    const freshRequestId = await withTenant(pool, B, (tx) =>
      tx.query(
        `insert into approval_request (id, workspace_id, campaign_id, content_version_id, target_channel) values (gen_random_uuid(), $1, $2, $3, 'meta_page') returning id`,
        [B, chains[B]!.campaignId, chains[B]!.contentVersionId],
      ).then((r) => r.rows[0].id as string));
    const result = await withTenant(pool, B, (tx) =>
      tx.query(
        `insert into approval_decision (id, workspace_id, approval_request_id, actor_user_id, decision, reason) values (gen_random_uuid(), $1, $2, $3, 'approve', 'legit') returning id, approval_request_id`,
        [B, freshRequestId, userId],
      ));
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].approval_request_id).toBe(freshRequestId);
  });
});
