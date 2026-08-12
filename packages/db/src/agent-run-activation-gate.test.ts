// Task 7 hard requirement (2): "the activation gate must be closed at the
// database, not only in TypeScript... A run for a non-activated agent must
// be impossible to record, not merely impossible to start through the happy
// path." packages/domain/src/agent-registry.ts's assertActivated is a
// TypeScript-only gate; T6's own schema (infra/migrations/0024_agent_run.sql,
// applied, never edited) has NO constraint or trigger that looks at
// agent_version.activated before accepting an agent_run insert -- proven
// below BEFORE 0025_agent_run_activation_gate.sql closes it: this file's
// first test (run against the pre-0025 database) inserted successfully where
// it should have been refused. See task-7-report.md for that captured
// failing-test output; this file, as committed, asserts the now-closed
// behaviour.
//
// Connects and inserts directly as smos_app (pool below, same DATABASE_URL
// every other packages/db integration test uses) -- exactly the "direct SQL
// as smos_app" attack the task brief asks this to prove is refused, not a
// TypeScript-level assertActivated check.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@smos/domain";
import { createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);

// smos: bypasses RLS, used only to seed fixtures (agent_definition /
// agent_version rows this file needs, at both activated=true and
// activated=false) and for cleanup, since smos_app has no DELETE grant on
// any of these tables (0024_agent_run.sql's own GRANT list).
const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);

const workspaceId = newId();
const goalId = newId();
const campaignId = newId();
const inactiveDefId = newId();
const inactiveVersionId = newId();
const activeDefId = newId();
const activeVersionId = newId();

const createdRunIds: string[] = [];

beforeAll(async () => {
  await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [
    workspaceId,
    `t7-gate-${workspaceId}`,
  ]);
  await adminPool.query(`insert into goal (id, workspace_id, statement) values ($1, $2, 't7 gate seed goal')`, [
    goalId,
    workspaceId,
  ]);
  await adminPool.query(
    `insert into campaign (id, workspace_id, goal_id, name, state) values ($1, $2, $3, $4, 'DRAFT')`,
    [campaignId, workspaceId, goalId, `t7-gate-campaign-${campaignId}`],
  );

  // A legitimate M1 role (content), but this particular VERSION is not
  // activated -- e.g. a draft awaiting activation. This is the realistic
  // shape of the gap: not "an illegal role" (0013's trigger already refuses
  // marking a non-M1 role activated=true at all), but "an agent_version
  // that correctly has activated=false", which nothing before 0025 stopped
  // an agent_run from referencing anyway.
  await adminPool.query(
    `insert into agent_definition (id, workspace_id, role, mission) values ($1, $2, 'content', 't7 gate inactive')`,
    [inactiveDefId, workspaceId],
  );
  await adminPool.query(
    `insert into agent_version (id, workspace_id, agent_definition_id, version_number, activated, prompt_version, model_version, budget_usd)
     values ($1, $2, $3, 1, false, 'p1', 'm1', 1.0)`,
    [inactiveVersionId, workspaceId, inactiveDefId],
  );

  // Control: a genuinely activated M1 role/version, proving the trigger
  // does not also refuse the legitimate case.
  await adminPool.query(
    `insert into agent_definition (id, workspace_id, role, mission) values ($1, $2, 'research', 't7 gate active')`,
    [activeDefId, workspaceId],
  );
  await adminPool.query(
    `insert into agent_version (id, workspace_id, agent_definition_id, version_number, activated, prompt_version, model_version, budget_usd)
     values ($1, $2, $3, 1, true, 'p1', 'm1', 1.0)`,
    [activeVersionId, workspaceId, activeDefId],
  );
});

afterAll(async () => {
  try {
    // Sweeps by workspace_id, not only createdRunIds -- if a test's
    // assertion about *rejection* itself fails (the exact failure mode
    // this file's pre-0025 run hit: the insert unexpectedly succeeded),
    // createdRunIds never gets pushed to, but the row still exists and
    // still holds an FK to agent_version/campaign that would otherwise
    // block every delete below. Scoping to workspaceId catches it either
    // way.
    const leaked = await adminPool.query(`select id from agent_run where workspace_id = $1`, [workspaceId]);
    const runIds = [...new Set([...createdRunIds, ...leaked.rows.map((r: { id: string }) => r.id)])];
    if (runIds.length > 0) {
      await adminPool.query(`delete from tool_call where agent_run_id = ANY($1::uuid[])`, [runIds]);
      await adminPool.query(`delete from run_checkpoint where agent_run_id = ANY($1::uuid[])`, [runIds]);
      await adminPool.query(`delete from agent_run where id = ANY($1::uuid[])`, [runIds]);
    }
    await adminPool.query(`delete from agent_version where id = ANY($1::uuid[])`, [
      [inactiveVersionId, activeVersionId],
    ]);
    await adminPool.query(`delete from agent_definition where id = ANY($1::uuid[])`, [[inactiveDefId, activeDefId]]);
    await adminPool.query(`delete from campaign where id = $1`, [campaignId]);
    await adminPool.query(`delete from goal where id = $1`, [goalId]);
    await adminPool.query(`delete from workspace where id = $1`, [workspaceId]);
  } finally {
    await pool.end();
    await adminPool.end();
  }
});

describe("agent_run activation gate is enforced at the database (requirement 2)", () => {
  it("refuses an agent_run insert -- direct SQL as smos_app -- referencing a non-activated agent_version", async () => {
    const runId = newId();
    await expect(
      withTenant(pool, workspaceId, (tx) =>
        tx.query(
          `insert into agent_run (id,workspace_id,agent_version_id,campaign_id,state,prompt_version,model_version)
           values ($1,$2,$3,$4,'pending','p1','m1')`,
          [runId, workspaceId, inactiveVersionId, campaignId],
        )),
    ).rejects.toThrow(/not activated|activation/i);

    // Prove the refusal actually rolled back -- no orphaned row left behind
    // for cleanup to silently paper over.
    const seen = await adminPool.query(`select 1 from agent_run where id = $1`, [runId]);
    expect(seen.rowCount).toBe(0);
  });

  it("still allows an agent_run insert referencing a genuinely activated agent_version", async () => {
    const runId = newId();
    await withTenant(pool, workspaceId, (tx) =>
      tx.query(
        `insert into agent_run (id,workspace_id,agent_version_id,campaign_id,state,prompt_version,model_version)
         values ($1,$2,$3,$4,'pending','p1','m1')`,
        [runId, workspaceId, activeVersionId, campaignId],
      ));
    createdRunIds.push(runId);

    const seen = await adminPool.query(`select id from agent_run where id = $1`, [runId]);
    expect(seen.rows).toHaveLength(1);
  });
});
