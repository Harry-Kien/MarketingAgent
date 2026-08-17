// P4 Task 9: closes the known cross-track gap -- submit-approval.ts's
// `isChannelConnected` was a documented stub that always returned false
// because, when P3 wrote it, there was no channel-integration table.
// 0028_integration.sql has since created `integration`; this wires the real
// check against it, against the real PostgreSQL on 5433, RLS-scoped exactly
// like every other query in this app.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "@smos/db";
import { newId, type Id } from "@smos/domain";
import { isChannelConnected, providerForChannel } from "./channel-status.ts";
import { recordSandboxVerification } from "./integration-verification.ts";

const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const appUrl = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);
const appPool = createDbPool(appUrl);

const workspaceId: Id = newId();

beforeAll(async () => {
  await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [
    workspaceId,
    `channel-status-${workspaceId}`,
  ]);
});

/** A real, complete publication chain ending in a succeeded publication with
 * a provider-assigned external_id -- the only thing that can now earn
 * `integration.status = 'sandbox'`. Seeded through the migration role,
 * exactly like every other fixture row in this file. */
async function seedSucceededPublication(): Promise<Id> {
  const userId = newId();
  const goalId = newId();
  const campaignId = newId();
  const itemId = newId();
  const versionId = newId();
  const requestId = newId();
  const decisionId = newId();
  const publicationId = newId();
  const content = `channel-status probe ${publicationId}`;

  await adminPool.query(`insert into user_account (id, email, name) values ($1, $2, 'probe')`, [
    userId,
    `channel-status-${publicationId}@test.local`,
  ]);
  await adminPool.query(`insert into goal (id, workspace_id, statement) values ($1, $2, 'channel status probe')`, [
    goalId,
    workspaceId,
  ]);
  await adminPool.query(
    `insert into campaign (id, workspace_id, goal_id, name, state) values ($1, $2, $3, $4, 'WAITING_APPROVAL')`,
    [campaignId, workspaceId, goalId, `channel-status-campaign-${campaignId}`],
  );
  await adminPool.query(
    `insert into content_item (id, workspace_id, campaign_id, kind, title) values ($1, $2, $3, 'social_post', $4)`,
    [itemId, workspaceId, campaignId, `channel-status-item-${itemId}`],
  );
  await adminPool.query(
    `insert into content_version (id, workspace_id, content_item_id, version_number, body, publication_content)
     values ($1, $2, $3, 1, 'body', $4)`,
    [versionId, workspaceId, itemId, content],
  );
  await adminPool.query(
    `insert into approval_request (id, workspace_id, campaign_id, content_version_id, target_channel)
     values ($1, $2, $3, $4, 'meta_page')`,
    [requestId, workspaceId, campaignId, versionId],
  );
  await adminPool.query(
    `insert into approval_decision (id, workspace_id, approval_request_id, actor_user_id, decision, reason)
     values ($1, $2, $3, $4, 'approve', 'probe approval')`,
    [decisionId, workspaceId, requestId, userId],
  );
  await adminPool.query(
    `insert into publication (id, workspace_id, campaign_id, content_version_id, approval_decision_id,
                              publication_content, content_hash, idempotency_key, target_channel, state, external_id)
     values ($1, $2, $3, $4, $5, $6, encode(digest($6, 'sha256'), 'hex'), $7, 'meta_page', 'succeeded', $8)`,
    [publicationId, workspaceId, campaignId, versionId, decisionId, content, newId(), `page-1_${publicationId}`],
  );
  return publicationId;
}

afterAll(async () => {
  // Only the rows this file can actually remove. `seedSucceededPublication`
  // builds a full goal -> campaign -> ... -> approval_decision -> publication
  // chain, and approval_decision/audit_log are append-only for every role
  // (0001/0007), which transitively pins everything they reference -- the
  // workspace included. Same convention as cross-tenant.test.ts and
  // apps/web/e2e/fixtures/seed.ts: every id here comes from newId(), so what
  // is left behind can never collide with a later run.
  await adminPool.query(`delete from integration where workspace_id = $1`, [workspaceId]);
  await adminPool.end();
  await appPool.end();
});

describe("providerForChannel", () => {
  it("derives the provider from the leading segment of the channel name", () => {
    expect(providerForChannel("meta_page")).toBe("meta");
  });
  it("returns the whole string when there is no underscore, rather than throwing", () => {
    expect(providerForChannel("meta")).toBe("meta");
  });
});

describe("isChannelConnected", () => {
  it("is false with no integration row at all -- fails closed, never infers a connection from silence", async () => {
    await expect(isChannelConnected(appPool, workspaceId, "meta_page")).resolves.toBe(false);
  });

  it("is false when a row exists but is merely disconnected", async () => {
    const id = newId();
    await adminPool.query(`insert into integration (id, workspace_id, provider, status) values ($1, $2, 'meta', 'disconnected')`, [
      id,
      workspaceId,
    ]);
    await expect(isChannelConnected(appPool, workspaceId, "meta_page")).resolves.toBe(false);
    await adminPool.query(`delete from integration where id = $1`, [id]);
  });

  it("is true once the integration is genuinely connected", async () => {
    const id = newId();
    await adminPool.query(`insert into integration (id, workspace_id, provider, status) values ($1, $2, 'meta', 'connected')`, [
      id,
      workspaceId,
    ]);
    await expect(isChannelConnected(appPool, workspaceId, "meta_page")).resolves.toBe(true);
    await adminPool.query(`delete from integration where id = $1`, [id]);
  });

  // Corrected for late-review IMPORTANT 3. This test used to INSERT
  // `status = 'sandbox'` directly and assert the gate opened -- i.e. it
  // encoded the defect as the expected behaviour, which is exactly why
  // nothing caught that the strongest claim in the system ("đã xác minh")
  // could be typed rather than earned. The property it means to prove is
  // real and is still proved: a genuinely sandbox-verified channel opens the
  // gate. What changed is how the row comes to exist -- through
  // `recordSandboxVerification`, which can only name a publication that
  // actually reached 'succeeded' with a provider-assigned external_id
  // (0033_integration_sandbox_must_be_earned.sql enforces the rest).
  it("is true once the integration is genuinely sandbox-verified by a real successful publication", async () => {
    const publicationId = await seedSucceededPublication();
    await recordSandboxVerification(appPool, workspaceId, { targetChannel: "meta_page", publicationId });
    await expect(isChannelConnected(appPool, workspaceId, "meta_page")).resolves.toBe(true);
    await adminPool.query(`delete from integration where workspace_id = $1 and provider = 'meta'`, [workspaceId]);
  });

  it("cannot be opened by asserting 'sandbox' with no verifying publication at all", async () => {
    await expect(
      adminPool.query(`insert into integration (id, workspace_id, provider, status) values ($1, $2, 'meta', 'sandbox')`, [
        newId(),
        workspaceId,
      ]),
    ).rejects.toThrow(/check|violates/i);
    await expect(isChannelConnected(appPool, workspaceId, "meta_page")).resolves.toBe(false);
  });

  it("never reads a different workspace's integration row (RLS-scoped like every other query)", async () => {
    const otherWorkspaceId = newId();
    await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [otherWorkspaceId, `other-${otherWorkspaceId}`]);
    const id = newId();
    await adminPool.query(`insert into integration (id, workspace_id, provider, status) values ($1, $2, 'meta', 'connected')`, [
      id,
      otherWorkspaceId,
    ]);
    try {
      await expect(isChannelConnected(appPool, workspaceId, "meta_page")).resolves.toBe(false);
    } finally {
      await adminPool.query(`delete from integration where id = $1`, [id]);
      await adminPool.query(`delete from workspace where id = $1`, [otherWorkspaceId]);
    }
  });
});
