// Task 7 hard requirement (1): "persist the agent output... within the same
// transaction that records the run's terminal state, so a crash cannot
// leave a run marked complete with its output missing." packages/agents/src/
// runtime.ts forwards `parse()`'s return value to RunStore.finishRun's
// (extended) `output` field on success and never otherwise -- proved
// against a mock store in packages/agents/src/runtime.test.ts. This file
// proves the other half: the real, Postgres-backed RunStore actually
// writes that output durably, in the SAME database transaction as the
// terminal-state update, using only the jsonb column T6's schema already
// has (run_checkpoint.state_blob -- no new column, per the task's own
// instruction to stop and ask before adding one).
//
// This is also, structurally, task 10's "RunStore thật trên Postgres"
// (docs/superpowers/plans/2026-08-11-p2-agent-runtime-approval.md) pulled
// forward: task 7's hard requirements cannot be closed with only a mock
// store, since "same transaction" and "survives a crash" are properties of
// a real database connection, never of an in-memory test double. Every
// write goes through withTenant (RLS confines it to one workspace, D1-3),
// same as every other repository in this package.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId, type Id } from "@smos/domain";
import { createDbPool } from "../client.ts";
import { withTenant } from "../tenant-scope.ts";
import { createRunStore } from "./run-store.ts";

const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);

// smos_app has no DELETE grant on agent_run/tool_call/run_checkpoint
// (0024_agent_run.sql's GRANT list) -- cleanup goes through the migration
// role, same as every other integration test in this package.
const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);

const workspaceId = newId();
const otherWorkspaceId = newId();
const goalId = newId();
const campaignId = newId();
const otherGoalId = newId();
const otherCampaignId = newId();
const agentDefId = newId();
const agentVersionId = newId();

const createdRunIds: string[] = [];

async function seedWorkspace(ws: Id, goal: Id, campaign: Id, label: string) {
  await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [ws, `t7-runstore-${label}-${ws}`]);
  await adminPool.query(`insert into goal (id, workspace_id, statement) values ($1, $2, 't7 runstore seed goal')`, [
    goal,
    ws,
  ]);
  await adminPool.query(
    `insert into campaign (id, workspace_id, goal_id, name, state) values ($1, $2, $3, $4, 'DRAFT')`,
    [campaign, ws, goal, `t7-runstore-campaign-${campaign}`],
  );
}

beforeAll(async () => {
  await seedWorkspace(workspaceId, goalId, campaignId, "a");
  await seedWorkspace(otherWorkspaceId, otherGoalId, otherCampaignId, "b");

  await adminPool.query(
    `insert into agent_definition (id, workspace_id, role, mission) values ($1, $2, 'content', 't7 runstore seed')`,
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
    const leaked = await adminPool.query(
      `select id from agent_run where workspace_id in ($1, $2)`,
      [workspaceId, otherWorkspaceId],
    );
    const runIds = [...new Set([...createdRunIds, ...leaked.rows.map((r: { id: string }) => r.id)])];
    if (runIds.length > 0) {
      await adminPool.query(`delete from tool_call where agent_run_id = ANY($1::uuid[])`, [runIds]);
      await adminPool.query(`delete from run_checkpoint where agent_run_id = ANY($1::uuid[])`, [runIds]);
      await adminPool.query(`delete from agent_run where id = ANY($1::uuid[])`, [runIds]);
    }
    await adminPool.query(`delete from agent_version where id = $1`, [agentVersionId]);
    await adminPool.query(`delete from agent_definition where id = $1`, [agentDefId]);
    await adminPool.query(`delete from campaign where id = ANY($1::uuid[])`, [[campaignId, otherCampaignId]]);
    await adminPool.query(`delete from goal where id = ANY($1::uuid[])`, [[goalId, otherGoalId]]);
    await adminPool.query(`delete from workspace where id = ANY($1::uuid[])`, [[workspaceId, otherWorkspaceId]]);
  } finally {
    await pool.end();
    await adminPool.end();
  }
});

describe("createRunStore: persists a run, its checkpoints and its terminal state", () => {
  it("round-trips createRun / checkpoint / finishRun", async () => {
    const store = createRunStore(pool, workspaceId);
    const runId = await store.createRun({ workspaceId, agentVersionId, campaignId, correlationId: newId() });
    createdRunIds.push(runId);

    await store.checkpoint(runId, "prompt_built", { n: 1 });
    await store.finishRun(runId, { state: "succeeded", costUsd: 0.01, budgetExceeded: false });

    const run = await withTenant(pool, workspaceId, (tx) =>
      tx.query("select state, cost_usd from agent_run where id=$1", [runId]));
    expect(run.rows[0].state).toBe("succeeded");
    expect(run.rows[0].cost_usd).toBe("0.010000");

    const cps = await withTenant(pool, workspaceId, (tx) =>
      tx.query("select step_name from run_checkpoint where agent_run_id=$1 order by created_at", [runId]));
    expect(cps.rows.map((r: { step_name: string }) => r.step_name)).toEqual(["prompt_built"]);
  });

  // Requirement 1's core proof: output is written to run_checkpoint.state_blob
  // (the jsonb column T6's schema provides -- no new column added) in the
  // SAME call, and therefore the same withTenant transaction, as the
  // terminal-state UPDATE.
  it("finishRun with an output persists it into run_checkpoint.state_blob alongside the terminal state", async () => {
    const store = createRunStore(pool, workspaceId);
    const runId = await store.createRun({ workspaceId, agentVersionId, campaignId, correlationId: newId() });
    createdRunIds.push(runId);

    const output = { findings: [{ claim: "widgets outperform gadgets", verificationStatus: "VERIFIED" }] };
    await store.finishRun(runId, { state: "succeeded", costUsd: 0.02, budgetExceeded: false, output });

    const run = await withTenant(pool, workspaceId, (tx) =>
      tx.query("select state from agent_run where id=$1", [runId]));
    expect(run.rows[0].state).toBe("succeeded");

    const cp = await withTenant(pool, workspaceId, (tx) =>
      tx.query(
        "select state_blob from run_checkpoint where agent_run_id=$1 and step_name='output_persisted'",
        [runId],
      ));
    expect(cp.rows).toHaveLength(1);
    expect(cp.rows[0].state_blob).toEqual({ output });
  });

  it("finishRun never persists an output field on the failure path", async () => {
    const store = createRunStore(pool, workspaceId);
    const runId = await store.createRun({ workspaceId, agentVersionId, campaignId, correlationId: newId() });
    createdRunIds.push(runId);

    await store.finishRun(runId, { state: "failed_terminal", costUsd: 0, budgetExceeded: false, errorCode: "RUN_FAILED" });

    const cp = await withTenant(pool, workspaceId, (tx) =>
      tx.query(
        "select 1 from run_checkpoint where agent_run_id=$1 and step_name='output_persisted'",
        [runId],
      ));
    expect(cp.rowCount).toBe(0);
  });

  // Atomicity proof: force the terminal-state UPDATE to violate agent_run's
  // own CHECK (state IN (...)) constraint while an output is also supplied.
  // If the two writes were two separate transactions (checkpoint-then-update,
  // or update-then-checkpoint with no shared transaction), one half could
  // commit while the other rolls back. Because both statements run inside
  // ONE withTenant call, PostgreSQL guarantees all-or-nothing: this asserts
  // that when the state write is refused, the output checkpoint was never
  // written either, even though nothing here manually undoes it.
  it("rolls back the output checkpoint too when the terminal-state write itself is refused", async () => {
    const store = createRunStore(pool, workspaceId);
    const runId = await store.createRun({ workspaceId, agentVersionId, campaignId, correlationId: newId() });
    createdRunIds.push(runId);

    await expect(
      store.finishRun(runId, { state: "NONSENSE", costUsd: 0, budgetExceeded: false, output: { should: "never persist" } }),
    ).rejects.toThrow(/check|violates/i);

    const cp = await withTenant(pool, workspaceId, (tx) =>
      tx.query(
        "select 1 from run_checkpoint where agent_run_id=$1 and step_name='output_persisted'",
        [runId],
      ));
    expect(cp.rowCount).toBe(0);
  });

  // Fix round 1, IMPORTANT: the reviewer proved by mutation that the test
  // above ("rolls back the output checkpoint too...") never actually
  // exercises atomicity -- it forces the UPDATE (statement 1) itself to
  // fail via an invalid state value, so the INSERT (statement 2) never even
  // runs; splitting finishRun into two separate transactions makes 0 of 836
  // tests fail. This test instead forces the SECOND statement (the
  // run_checkpoint INSERT) to fail while the FIRST statement (the agent_run
  // UPDATE) is entirely valid and would succeed on its own -- via a
  // temporary trigger installed for the duration of this one test, through
  // the migration role (smos_app has no CREATE anywhere, per
  // STANDING-CONTEXT.md). If finishRun's two writes are in one transaction
  // (the real implementation), the failed INSERT rolls the UPDATE back too,
  // so `state` never becomes "succeeded". If they were split into two
  // withTenant calls, the UPDATE would already have committed by the time
  // the INSERT fails -- exactly the "run marked complete with its output
  // missing" failure requirement (1) exists to prevent.
  it("MUTATION GUARD: forcing only the output checkpoint write to fail must also undo the terminal-state write", async () => {
    const store = createRunStore(pool, workspaceId);
    const runId = await store.createRun({ workspaceId, agentVersionId, campaignId, correlationId: newId() });
    createdRunIds.push(runId);

    await adminPool.query(`
      CREATE OR REPLACE FUNCTION t7_mutation_guard_block_output_checkpoint() RETURNS trigger AS $$
      BEGIN
        IF NEW.state_blob ? 'output' THEN
          RAISE EXCEPTION 'MUTATION GUARD: forced failure for atomicity test';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS t7_mutation_guard_block_output_checkpoint ON run_checkpoint;
      CREATE TRIGGER t7_mutation_guard_block_output_checkpoint
        BEFORE INSERT ON run_checkpoint
        FOR EACH ROW
        EXECUTE FUNCTION t7_mutation_guard_block_output_checkpoint();
    `);

    try {
      await expect(
        store.finishRun(runId, {
          state: "succeeded",
          costUsd: 0.5,
          budgetExceeded: false,
          output: { should: "never persist" },
        }),
      ).rejects.toThrow(/MUTATION GUARD/i);

      const run = await adminPool.query(`select state, cost_usd from agent_run where id=$1`, [runId]);
      // "running" is what createRun set it to; the point is specifically
      // that it must NOT be "succeeded" -- the terminal state the failed
      // call asked for -- because that write was never allowed to commit
      // on its own.
      expect(run.rows[0].state).not.toBe("succeeded");
      expect(run.rows[0].cost_usd).not.toBe("0.500000");
    } finally {
      await adminPool.query(`
        DROP TRIGGER IF EXISTS t7_mutation_guard_block_output_checkpoint ON run_checkpoint;
        DROP FUNCTION IF EXISTS t7_mutation_guard_block_output_checkpoint();
      `);
    }
  });

  // E15 / adversarial check: a run created in one workspace must be
  // completely invisible to a RunStore scoped to a different workspace.
  it("E15: a run in workspace B cannot see a run in workspace A", async () => {
    const storeA = createRunStore(pool, workspaceId);
    const runId = await storeA.createRun({ workspaceId, agentVersionId, campaignId, correlationId: newId() });
    createdRunIds.push(runId);

    const seenFromB = await withTenant(pool, otherWorkspaceId, (tx) =>
      tx.query("select id from agent_run where id=$1", [runId]));
    expect(seenFromB.rowCount).toBe(0);
  });

  // Fix round 2, MINOR: tool_name and args are attacker-influenced (a
  // model chose them) and otherwise unbounded. Reproduced live: a NUL byte
  // in the name made the INSERT itself throw an "invalid byte sequence for
  // encoding UTF8" error -- PostgreSQL's text type cannot store U+0000 at
  // all. The call still fails closed (T4's registry never runs the handler
  // either way), but the audit row T6's own header says a refused call
  // must never be silently omitted was never written. Sanitised the same
  // way tools.ts already truncates a refused tool name before logging it
  // (MAX_LOGGED_TOOL_NAME_LENGTH).
  it("a tool name containing a NUL byte still produces an audit row instead of throwing", async () => {
    const store = createRunStore(pool, workspaceId);
    const runId = await store.createRun({ workspaceId, agentVersionId, campaignId, correlationId: newId() });
    createdRunIds.push(runId);

    // Built via String.fromCharCode, never a literal escape sequence in
    // source, so the real U+0000 code point is unambiguous here.
    const nul = String.fromCharCode(0);
    const hostileName = ["publish", "meta"].join(nul);
    const hostileArgs = { note: ["hi", "there"].join(nul) };

    // Must not throw -- this is the reproduced bug.
    await store.recordToolCall(runId, { name: hostileName, allowed: false, args: hostileArgs });

    const row = await withTenant(pool, workspaceId, (tx) =>
      tx.query("select tool_name, args from tool_call where agent_run_id=$1", [runId]));
    expect(row.rows).toHaveLength(1);
    expect((row.rows[0].tool_name as string).includes(nul)).toBe(false);
    expect(JSON.stringify(row.rows[0].args).includes(nul)).toBe(false);
  });

  it("an oversized tool name is bounded rather than stored in full", async () => {
    const store = createRunStore(pool, workspaceId);
    const runId = await store.createRun({ workspaceId, agentVersionId, campaignId, correlationId: newId() });
    createdRunIds.push(runId);

    const hugeName = "a".repeat(5000);
    await store.recordToolCall(runId, { name: hugeName, allowed: false, args: {} });

    const row = await withTenant(pool, workspaceId, (tx) =>
      tx.query("select tool_name from tool_call where agent_run_id=$1", [runId]));
    expect((row.rows[0].tool_name as string).length).toBeLessThan(5000);
  });
});
