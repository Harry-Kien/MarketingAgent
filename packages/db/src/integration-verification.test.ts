// Late-review IMPORTANT 3: `integration.status = 'sandbox'` was a bare
// assertion.
//
// The reviewer inserted that value directly and the UI immediately showed
// the badge "Sandbox (đã xác minh)" -- literally "verified" -- and
// `isChannelConnected` flipped to true, opening the channel gate on the
// approval path. Nothing in the codebase ever WROTE integration.status, so
// there was no verification-then-write to defeat: the strongest evidentiary
// claim this milestone can make was available to anyone who could type an
// INSERT.
//
// The fix makes the claim earn itself: 'sandbox' now requires naming a real
// publication in the same workspace that actually reached state 'succeeded'
// with an external_id assigned by the provider -- which in turn requires a
// real approval_decision by a real user (publication.approval_decision_id is
// NOT NULL and foreign-keyed), so the claim chains all the way back to a
// human approval. Every attempt below runs as smos_app.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@smos/domain";
import { createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const adminPool = createDbPool(adminUrl);

const workspaceId = newId();
const otherWorkspaceId = newId();
let succeededPublicationId: string;
let preparedPublicationId: string;
let foreignPublicationId: string;

/** Seeds workspace -> user -> goal -> campaign -> content -> approval ->
 * publication, as the migration role, and returns the publication id.
 * `state`/`externalId` are what each test varies. */
async function seedPublication(
  ws: string,
  state: "prepared" | "succeeded",
  externalId: string | null,
  targetChannel = "meta_page",
): Promise<string> {
  const userId = newId();
  const goalId = newId();
  const campaignId = newId();
  const itemId = newId();
  const versionId = newId();
  const requestId = newId();
  const decisionId = newId();
  const publicationId = newId();
  const content = `integration verification probe ${publicationId}`;

  await adminPool.query(`insert into user_account (id, email, name) values ($1, $2, 'probe')`, [
    userId,
    `integration-verify-${publicationId}@test.local`,
  ]);
  // 0037_approval_actor_must_be_a_member.sql: an approval_decision's actor
  // must hold a workspace_member row in the workspace being approved for,
  // so this probe's approver is enrolled as an actual member rather than
  // being a bare user_account row that merely exists somewhere. Must happen
  // before the approval_decision insert below -- approval_decision
  // (workspace_id, actor_user_id) is now a composite foreign key onto
  // workspace_member (workspace_id, user_id).
  await adminPool.query(
    `insert into workspace_member (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [newId(), ws, userId],
  );
  await adminPool.query(`insert into goal (id, workspace_id, statement) values ($1, $2, 'integration verify probe')`, [
    goalId,
    ws,
  ]);
  await adminPool.query(
    `insert into campaign (id, workspace_id, goal_id, name, state) values ($1, $2, $3, $4, 'WAITING_APPROVAL')`,
    [campaignId, ws, goalId, `integration-verify-campaign-${campaignId}`],
  );
  await adminPool.query(
    `insert into content_item (id, workspace_id, campaign_id, kind, title) values ($1, $2, $3, 'social_post', $4)`,
    [itemId, ws, campaignId, `integration-verify-item-${itemId}`],
  );
  await adminPool.query(
    `insert into content_version (id, workspace_id, content_item_id, version_number, body, publication_content)
     values ($1, $2, $3, 1, 'body', $4)`,
    [versionId, ws, itemId, content],
  );
  await adminPool.query(
    `insert into approval_request (id, workspace_id, campaign_id, content_version_id, target_channel)
     values ($1, $2, $3, $4, $5)`,
    [requestId, ws, campaignId, versionId, targetChannel],
  );
  await adminPool.query(
    `insert into approval_decision (id, workspace_id, approval_request_id, actor_user_id, decision, reason)
     values ($1, $2, $3, $4, 'approve', 'probe approval')`,
    [decisionId, ws, requestId, userId],
  );
  await adminPool.query(
    `insert into publication (id, workspace_id, campaign_id, content_version_id, approval_decision_id,
                              publication_content, content_hash, idempotency_key, target_channel, state, external_id)
     values ($1, $2, $3, $4, $5, $6, encode(digest($6, 'sha256'), 'hex'), $7, $8, $9, $10)`,
    [publicationId, ws, campaignId, versionId, decisionId, content, newId(), targetChannel, state, externalId],
  );
  return publicationId;
}

async function insertIntegration(
  ws: string,
  status: string,
  verifiedPublicationId: string | null,
  provider = "meta",
): Promise<void> {
  await withTenant(pool, ws, (tx) =>
    tx.query(
      `insert into integration (id, workspace_id, provider, status, verified_publication_id)
       values ($1, $2, $3, $4, $5)`,
      [newId(), ws, provider, status, verifiedPublicationId],
    ),
  );
}

beforeAll(async () => {
  for (const ws of [workspaceId, otherWorkspaceId]) {
    await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [ws, `integration-verify-${ws}`]);
  }
  succeededPublicationId = await seedPublication(workspaceId, "succeeded", `page-1_${newId()}`);
  preparedPublicationId = await seedPublication(workspaceId, "prepared", null);
  foreignPublicationId = await seedPublication(otherWorkspaceId, "succeeded", `page-1_${newId()}`);
});

afterAll(async () => {
  for (const ws of [workspaceId, otherWorkspaceId]) {
    await adminPool.query(`delete from integration where workspace_id = $1`, [ws]).catch(() => undefined);
  }
  await pool.end();
  await adminPool.end();
});

describe("integration.status = 'sandbox' must be earned (IMPORTANT 3)", () => {
  it("refuses the reviewer's bare assertion: 'sandbox' with no verifying publication", async () => {
    await expect(insertIntegration(workspaceId, "sandbox", null)).rejects.toThrow(/integration_sandbox_needs_evidence_check/);
  });

  it("refuses 'sandbox' pointing at a publication that never actually succeeded", async () => {
    await expect(insertIntegration(workspaceId, "sandbox", preparedPublicationId)).rejects.toThrow(
      /which is not evidence the adapter ever succeeded/,
    );
  });

  it("refuses 'sandbox' pointing at ANOTHER workspace's successful publication", async () => {
    // Refused by the trigger's own same-workspace lookup first; the
    // composite foreign key (verified_publication_id, workspace_id) would
    // refuse it independently if the trigger were dropped, which is what the
    // mutation test for this migration checks.
    await expect(insertIntegration(workspaceId, "sandbox", foreignPublicationId)).rejects.toThrow(
      /integration_verified_publication_fkey/,
    );
  });

  it("refuses 'sandbox' whose verifying publication went to a different provider's channel", async () => {
    const tiktokPublicationId = await seedPublication(workspaceId, "succeeded", `tt_${newId()}`, "tiktok_account");
    await expect(insertIntegration(workspaceId, "sandbox", tiktokPublicationId)).rejects.toThrow(
      /cannot be verified by a publication sent to channel/,
    );
  });

  it("accepts 'sandbox' backed by a real successful publication on this provider's channel", async () => {
    await insertIntegration(workspaceId, "sandbox", succeededPublicationId, "meta");
    const r = await adminPool.query(
      `select status, verified_publication_id from integration where workspace_id = $1 and provider = 'meta'`,
      [workspaceId],
    );
    expect(r.rows[0].status).toBe("sandbox");
    expect(r.rows[0].verified_publication_id).toBe(succeededPublicationId);
  });

  it("refuses promoting an existing row to 'sandbox' by UPDATE, the other door into the same claim", async () => {
    await insertIntegration(workspaceId, "disconnected", null, "linkedin");
    await expect(
      withTenant(pool, workspaceId, (tx) =>
        tx.query(`update integration set status = 'sandbox' where workspace_id = $1 and provider = 'linkedin'`, [
          workspaceId,
        ]),
      ),
    ).rejects.toThrow(/integration_sandbox_needs_evidence_check/);
  });
});
