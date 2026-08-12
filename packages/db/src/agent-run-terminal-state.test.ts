// Task 7 fix round 1, IMPORTANT finding 3: "no terminal state is actually
// terminal." Reproduced live (see task-7-report.md, Fix round 1) before
// 0026_agent_run_terminal_state.sql existed: `finishRun(run,
// {state:"succeeded", ...})` followed by `finishRun(run, {state:"running",
// costUsd:0})` both succeeded as smos_app, leaving `{state:"running",
// cost_usd:"0.000000"}` with the `output_persisted` checkpoint (written
// while the run still claimed to be succeeded) orphaned behind it.
//
// Fix round 2, IMPORTANT: 0026's trigger was `BEFORE UPDATE OF state`, so
// an UPDATE that never names `state` in its SET clause never fires it at
// all. Reproduced live as smos_app on a succeeded run: `update agent_run
// set cost_usd=999, tokens_out=999, error_code='rewritten'` was ACCEPTED.
// A terminal run is an audit record, not merely a state machine that
// stopped moving -- 0027_agent_run_immutable_when_terminal.sql widens the
// guard (same function name, CREATE OR REPLACE, per this repo's forward-
// only convention -- 0026 is applied and never edited) to freeze every
// column except `updated_at` the instant `state` is terminal, following
// the same principle P1 used for approval_decision (0007) and publication
// (0011) immutability.
//
// This file's own round-1 test, "still allows a no-op update that names
// state but does not change it, even for a terminal run", asserted that
// changing cost_usd on a terminal row (while leaving state unchanged)
// SUCCEEDS -- that is now WRONG per round 2's finding (cost_usd must be
// frozen too) and has been corrected below, not silently left in place.
//
// Proved with direct SQL as smos_app throughout -- no TypeScript-level
// check anywhere in this file's call path.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@smos/domain";
import { createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);

const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);

const workspaceId = newId();
const goalId = newId();
const campaignId = newId();
const agentDefId = newId();
const agentVersionId = newId();

const createdRunIds: string[] = [];

beforeAll(async () => {
  await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [
    workspaceId,
    `t7-terminal-${workspaceId}`,
  ]);
  await adminPool.query(`insert into goal (id, workspace_id, statement) values ($1, $2, 't7 terminal seed goal')`, [
    goalId,
    workspaceId,
  ]);
  await adminPool.query(
    `insert into campaign (id, workspace_id, goal_id, name, state) values ($1, $2, $3, $4, 'DRAFT')`,
    [campaignId, workspaceId, goalId, `t7-terminal-campaign-${campaignId}`],
  );
  await adminPool.query(
    `insert into agent_definition (id, workspace_id, role, mission) values ($1, $2, 'content', 't7 terminal seed')`,
    [agentDefId, workspaceId],
  );
  await adminPool.query(
    `insert into agent_version (id, workspace_id, agent_definition_id, version_number, activated, prompt_version, model_version, budget_usd)
     values ($1, $2, $3, 1, true, 'p1', 'm1', 1.0)`,
    [agentVersionId, workspaceId, agentDefId],
  );
});

afterAll(async () => {
  try {
    if (createdRunIds.length > 0) {
      await adminPool.query(`delete from run_checkpoint where agent_run_id = ANY($1::uuid[])`, [createdRunIds]);
      await adminPool.query(`delete from agent_run where id = ANY($1::uuid[])`, [createdRunIds]);
    }
    await adminPool.query(`delete from agent_version where id = $1`, [agentVersionId]);
    await adminPool.query(`delete from agent_definition where id = $1`, [agentDefId]);
    await adminPool.query(`delete from campaign where id = $1`, [campaignId]);
    await adminPool.query(`delete from goal where id = $1`, [goalId]);
    await adminPool.query(`delete from workspace where id = $1`, [workspaceId]);
  } finally {
    await pool.end();
    await adminPool.end();
  }
});

async function seedRunAt(state: string): Promise<string> {
  const runId = newId();
  await withTenant(pool, workspaceId, (tx) =>
    tx.query(
      `insert into agent_run (id,workspace_id,agent_version_id,campaign_id,state,prompt_version,model_version)
       values ($1,$2,$3,$4,$5,'p1','m1')`,
      [runId, workspaceId, agentVersionId, campaignId, state],
    ));
  createdRunIds.push(runId);
  return runId;
}

describe("agent_run terminal state is actually terminal (fix round 1, IMPORTANT)", () => {
  it("refuses moving a succeeded run back to running -- direct SQL as smos_app", async () => {
    const runId = await seedRunAt("succeeded");
    await expect(
      withTenant(pool, workspaceId, (tx) =>
        tx.query(`update agent_run set state='running' where id=$1`, [runId])),
    ).rejects.toThrow(/terminal/i);

    const row = await adminPool.query(`select state from agent_run where id=$1`, [runId]);
    expect(row.rows[0].state).toBe("succeeded");
  });

  it("refuses moving a failed_terminal run to a DIFFERENT terminal state (succeeded)", async () => {
    const runId = await seedRunAt("failed_terminal");
    await expect(
      withTenant(pool, workspaceId, (tx) =>
        tx.query(`update agent_run set state='succeeded' where id=$1`, [runId])),
    ).rejects.toThrow(/terminal/i);

    const row = await adminPool.query(`select state from agent_run where id=$1`, [runId]);
    expect(row.rows[0].state).toBe("failed_terminal");
  });

  it("refuses moving a cancelled run to any other state", async () => {
    const runId = await seedRunAt("cancelled");
    await expect(
      withTenant(pool, workspaceId, (tx) =>
        tx.query(`update agent_run set state='failed_retryable' where id=$1`, [runId])),
    ).rejects.toThrow(/terminal/i);
  });

  // CORRECTED from round 1 (see file header): a genuine no-op -- nothing
  // but `updated_at` changing -- must still succeed on a terminal run.
  // `succeeded -> succeeded` is exactly the coordinator's own required
  // case.
  it("still allows a genuine no-op update (state re-asserted to its own value, nothing else touched) on a terminal run", async () => {
    const runId = await seedRunAt("succeeded");
    await withTenant(pool, workspaceId, (tx) =>
      tx.query(`update agent_run set state='succeeded' where id=$1`, [runId]));

    const row = await adminPool.query(`select state from agent_run where id=$1`, [runId]);
    expect(row.rows[0].state).toBe("succeeded");
  });

  // Fix round 2, IMPORTANT: the exact bug reproduced live -- an UPDATE that
  // never names `state` at all must still be refused once the row is
  // terminal, not only UPDATEs that touch `state`.
  it("refuses rewriting audit columns (cost_usd, tokens_out, error_code) on a terminal run, even when state is never named in the SET clause", async () => {
    const runId = await seedRunAt("succeeded");
    await expect(
      withTenant(pool, workspaceId, (tx) =>
        tx.query(`update agent_run set cost_usd=999, tokens_out=999, error_code='rewritten' where id=$1`, [runId])),
    ).rejects.toThrow(/terminal|immutable/i);

    const row = await adminPool.query(`select cost_usd, tokens_out, error_code from agent_run where id=$1`, [runId]);
    expect(row.rows[0].cost_usd).not.toBe("999.000000");
    expect(row.rows[0].tokens_out).not.toBe(999);
    expect(row.rows[0].error_code).not.toBe("rewritten");
  });

  it("refuses a full-row-shaped update that re-asserts the same state but also changes cost_usd, once terminal", async () => {
    const runId = await seedRunAt("succeeded");
    await expect(
      withTenant(pool, workspaceId, (tx) =>
        tx.query(`update agent_run set state='succeeded', cost_usd=1.23 where id=$1`, [runId])),
    ).rejects.toThrow(/terminal|immutable/i);

    const row = await adminPool.query(`select cost_usd from agent_run where id=$1`, [runId]);
    expect(row.rows[0].cost_usd).not.toBe("1.230000");
  });

  it("control: running -> terminal (a genuine transition into a terminal state) still succeeds", async () => {
    const runId = await seedRunAt("running");
    await withTenant(pool, workspaceId, (tx) =>
      tx.query(`update agent_run set state='succeeded', cost_usd=0.42 where id=$1`, [runId]));
    const row = await adminPool.query(`select state, cost_usd from agent_run where id=$1`, [runId]);
    expect(row.rows[0].state).toBe("succeeded");
    expect(row.rows[0].cost_usd).toBe("0.420000");
  });

  it("control: a non-terminal run can still freely change state and other columns", async () => {
    const runId = await seedRunAt("running");
    await withTenant(pool, workspaceId, (tx) =>
      tx.query(`update agent_run set state='failed_retryable', cost_usd=0.1 where id=$1`, [runId]));
    const row = await adminPool.query(`select state, cost_usd from agent_run where id=$1`, [runId]);
    expect(row.rows[0].state).toBe("failed_retryable");
    expect(row.rows[0].cost_usd).toBe("0.100000");
  });
});
