import type pg from "pg";
import { newId, type Id } from "@smos/domain";

/**
 * One fully-populated workspace: one row in every workspace-owned table any
 * P1 or P2 task has added so far (goal, campaign, content_item,
 * content_version, source_citation, approval_request, approval_decision,
 * publication, agent_definition, agent_version, outbox, audit_log, and --
 * added by P2 task 6 -- agent_run, tool_call, run_checkpoint), wired
 * together with real, valid foreign keys. Used by
 * packages/db/src/cross-tenant.test.ts (E8/E14) as the "known-good" row set
 * for both workspace A and workspace B, so isolation can be proven against
 * real data rather than empty tables.
 */
export interface TenantFixture {
  workspaceId: Id;
  userId: Id;
  goalId: Id;
  campaignId: Id;
  contentItemId: Id;
  contentVersionId: Id;
  sourceCitationId: Id;
  approvalRequestId: Id;
  approvalDecisionId: Id;
  agentDefinitionId: Id;
  agentVersionId: Id;
  outboxId: Id;
  auditLogId: Id;
  publicationId: Id;
  agentRunId: Id;
  toolCallId: Id;
  runCheckpointId: Id;
}

async function seedOne(client: pg.PoolClient, label: string): Promise<TenantFixture> {
  const workspaceId = newId();
  const userId = newId();
  const goalId = newId();
  const campaignId = newId();
  const contentItemId = newId();
  const contentVersionId = newId();
  const sourceCitationId = newId();
  const approvalRequestId = newId();
  const approvalDecisionId = newId();
  const agentDefinitionId = newId();
  const agentVersionId = newId();
  const outboxId = newId();
  const auditLogId = newId();
  const publicationId = newId();
  const agentRunId = newId();
  const toolCallId = newId();
  const runCheckpointId = newId();

  // Seeded directly as the connecting (superuser) role, which always bypasses
  // RLS -- these rows exist to be *subjects* of the isolation proof, not to
  // exercise withTenant themselves.
  await client.query(`insert into workspace (id, name) values ($1, $2)`, [
    workspaceId,
    `e12-${label}-${workspaceId}`,
  ]);
  await client.query(`insert into user_account (id, email, name) values ($1, $2, $3)`, [
    userId,
    `e12-${label}-${workspaceId}@test.local`,
    label,
  ]);
  await client.query(`insert into goal (id, workspace_id, statement) values ($1, $2, 'e12 seed goal')`, [
    goalId,
    workspaceId,
  ]);
  await client.query(
    `insert into campaign (id, workspace_id, goal_id, name, state) values ($1, $2, $3, $4, 'WAITING_APPROVAL')`,
    [campaignId, workspaceId, goalId, `e12-${label}-campaign-${campaignId}`],
  );
  await client.query(
    `insert into content_item (id, workspace_id, campaign_id, kind, title) values ($1, $2, $3, 'social_post', $4)`,
    [contentItemId, workspaceId, campaignId, `e12-${label}-item-${contentItemId}`],
  );
  await client.query(
    `insert into content_version (id, workspace_id, content_item_id, version_number, body, publication_content)
     values ($1, $2, $3, 1, 'e12 seed body', 'e12 seed publication text')`,
    [contentVersionId, workspaceId, contentItemId],
  );
  await client.query(
    `insert into source_citation (id, workspace_id, content_version_id, url, accessed_at, excerpt, verification_status)
     values ($1, $2, $3, 'https://example.test/e12-seed', now(), 'e12 seed excerpt', 'VERIFIED')`,
    [sourceCitationId, workspaceId, contentVersionId],
  );
  await client.query(
    `insert into approval_request (id, workspace_id, campaign_id, content_version_id, target_channel)
     values ($1, $2, $3, $4, 'meta_page')`,
    [approvalRequestId, workspaceId, campaignId, contentVersionId],
  );
  await client.query(
    `insert into approval_decision (id, workspace_id, approval_request_id, actor_user_id, decision, reason)
     values ($1, $2, $3, $4, 'approve', 'e12 seed decision')`,
    [approvalDecisionId, workspaceId, approvalRequestId, userId],
  );
  // content_hash must equal sha256(publication_content) exactly --
  // publication_content_hash_check (0011_publication_immutability.sql) --
  // so it is computed in SQL from the same publication_content value, never
  // supplied as a literal.
  await client.query(
    `insert into publication (id, workspace_id, campaign_id, content_version_id, approval_decision_id,
                               publication_content, content_hash, idempotency_key, target_channel, state)
     values ($1, $2, $3, $4, $5, $6, encode(digest($6, 'sha256'), 'hex'), $7, 'meta_page', 'prepared')`,
    [
      publicationId,
      workspaceId,
      campaignId,
      contentVersionId,
      approvalDecisionId,
      "e12 seed publication text",
      `e12-key-${publicationId}`,
    ],
  );
  await client.query(
    `insert into agent_definition (id, workspace_id, role, mission) values ($1, $2, 'content', 'e12 seed mission')`,
    [agentDefinitionId, workspaceId],
  );
  await client.query(
    `insert into agent_version (id, workspace_id, agent_definition_id, version_number, activated,
                                 prompt_version, model_version, budget_usd)
     values ($1, $2, $3, 1, true, 'p1', 'm1', 1.0)`,
    [agentVersionId, workspaceId, agentDefinitionId],
  );
  await client.query(
    `insert into outbox (id, workspace_id, event_type, correlation_id) values ($1, $2, 'e12.seed.event', $3)`,
    [outboxId, workspaceId, newId()],
  );
  await client.query(
    `insert into audit_log (id, workspace_id, event_type, actor_kind) values ($1, $2, 'e12.seed.audit', 'system')`,
    [auditLogId, workspaceId],
  );
  // P2 task 6: agent_run.agent_version_id -> agent_version and
  // agent_run.campaign_id -> campaign are both composite tenant FKs, so this
  // run reuses the agentVersionId/campaignId already seeded above rather
  // than a fresh, unrelated pair.
  await client.query(
    `insert into agent_run (id, workspace_id, agent_version_id, campaign_id, state, prompt_version, model_version)
     values ($1, $2, $3, $4, 'pending', 'e12-seed-prompt', 'e12-seed-model')`,
    [agentRunId, workspaceId, agentVersionId, campaignId],
  );
  await client.query(
    `insert into tool_call (id, workspace_id, agent_run_id, tool_name, allowed) values ($1, $2, $3, 'e12_seed_tool', true)`,
    [toolCallId, workspaceId, agentRunId],
  );
  await client.query(
    `insert into run_checkpoint (id, workspace_id, agent_run_id, step_name) values ($1, $2, $3, 'e12_seed_step')`,
    [runCheckpointId, workspaceId, agentRunId],
  );

  return {
    workspaceId,
    userId,
    goalId,
    campaignId,
    contentItemId,
    contentVersionId,
    sourceCitationId,
    approvalRequestId,
    approvalDecisionId,
    agentDefinitionId,
    agentVersionId,
    outboxId,
    auditLogId,
    publicationId,
    agentRunId,
    toolCallId,
    runCheckpointId,
  };
}

/**
 * Seeds two fully-populated, unrelated workspaces. `pool` must connect as a
 * role that bypasses RLS (the migration-owner superuser) -- RLS is not in
 * play during seeding, only in the tests that read this data back through
 * `withTenant`.
 */
export async function seedTwoWorkspaces(pool: pg.Pool): Promise<{ a: TenantFixture; b: TenantFixture }> {
  const client = await pool.connect();
  try {
    return { a: await seedOne(client, "wsa"), b: await seedOne(client, "wsb") };
  } finally {
    client.release();
  }
}
