// Task 6: agent_run, tool_call, run_checkpoint. All three are workspace-owned
// per ADR-007: workspace_id NOT NULL, RLS ENABLED and FORCED, and a policy
// carrying both USING and WITH CHECK so smos_app can neither read nor write
// across a tenant boundary.
//
// agent_run.agent_version_id -> agent_version and agent_run.campaign_id ->
// campaign, and tool_call.agent_run_id / run_checkpoint.agent_run_id ->
// agent_run, are all composite foreign keys on (id, workspace_id) --
// 0008_composite_tenant_fk.sql's pattern: PostgreSQL evaluates a foreign key
// against its referenced table with RLS bypassed entirely, so a
// single-column FK would only prove *some* row with that id exists anywhere
// in the database, never that it belongs to the same workspace as the child
// row referencing it. This file proves, for each pair: (a) a cross-workspace
// reference is refused, (b) a same-workspace reference still works, and (c)
// row-level tenant isolation (read + write) holds on all three new tables.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { newId } from "@smos/domain";
import { seedTwoWorkspaces, type TenantFixture } from "@smos/testing";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);

// smos: the migration-owner superuser, which always bypasses RLS regardless
// of FORCE. Used only for seeding fixtures via seedTwoWorkspaces and for
// cleanup -- smos_app has no DELETE grant on agent_run / tool_call /
// run_checkpoint (this migration's own GRANT list), so any row this file
// creates must be removed through this pool, not through `pool` above.
const adminUrl =
  process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);

let a: TenantFixture;
let b: TenantFixture;

// Every row this file inserts beyond the seedTwoWorkspaces fixtures (which
// clean up after themselves via cross-tenant.test.ts / are otherwise
// harmless leftovers per that file's own note) is tracked here and deleted
// in afterAll -- this is a persistent, shared database with no per-test
// truncation.
const createdRunIds: string[] = [];

beforeAll(async () => {
  ({ a, b } = await seedTwoWorkspaces(adminPool));
});

afterAll(async () => {
  if (createdRunIds.length > 0) {
    // tool_call and run_checkpoint reference agent_run; deleting agent_run
    // first would violate their FK, so children go first. No ON DELETE
    // CASCADE is declared on either FK (deliberately -- a run's tool calls
    // and checkpoints are its own audit trail, never silently vanished by
    // deleting the parent), so both must be cleaned up explicitly here.
    await adminPool.query(`delete from tool_call where agent_run_id = ANY($1::uuid[])`, [createdRunIds]);
    await adminPool.query(`delete from run_checkpoint where agent_run_id = ANY($1::uuid[])`, [createdRunIds]);
    await adminPool.query(`delete from agent_run where id = ANY($1::uuid[])`, [createdRunIds]);
  }
  await pool.end();
  await adminPool.end();
});

describe("agent_run", () => {
  it("requires cost and budget columns", async () => {
    const r = await withTenant(pool, a.workspaceId, (tx) =>
      tx.query(`select column_name from information_schema.columns where table_name='agent_run'`),
    );
    const cols = r.rows.map((x: { column_name: string }) => x.column_name);
    for (const c of [
      "workspace_id", "cost_usd", "tokens_in", "tokens_out", "wallclock_ms",
      "budget_exceeded", "prompt_version", "model_version", "state",
    ]) {
      expect(cols, `missing ${c}`).toContain(c);
    }
  });

  it("refuses a run state outside the allowed set", async () => {
    await expect(
      withTenant(pool, a.workspaceId, (tx) =>
        tx.query(
          `insert into agent_run (id,workspace_id,agent_version_id,campaign_id,state,prompt_version,model_version)
           values (gen_random_uuid(),$1,$2,$3,'NONSENSE','p','m')`,
          [a.workspaceId, a.agentVersionId, a.campaignId],
        )),
    ).rejects.toThrow(/agent_run_state_check/);
  });

  it("refuses a blank prompt_version / model_version (whitespace-only)", async () => {
    await expect(
      withTenant(pool, a.workspaceId, (tx) =>
        tx.query(
          `insert into agent_run (id,workspace_id,agent_version_id,campaign_id,state,prompt_version,model_version)
           values (gen_random_uuid(),$1,$2,$3,'pending',$4,'m')`,
          [a.workspaceId, a.agentVersionId, a.campaignId, "\t\n"],
        )),
    ).rejects.toThrow(/agent_run_prompt_version_check/);
  });

  it("accepts a valid run and applies the documented defaults", async () => {
    const runId = newId();
    const inserted = await withTenant(pool, a.workspaceId, (tx) =>
      tx.query(
        `insert into agent_run (id,workspace_id,agent_version_id,campaign_id,state,prompt_version,model_version)
         values ($1,$2,$3,$4,'pending','p1','m1')
         returning cost_usd, tokens_in, tokens_out, wallclock_ms, budget_exceeded`,
        [runId, a.workspaceId, a.agentVersionId, a.campaignId],
      ));
    createdRunIds.push(runId);
    expect(inserted.rows[0]).toEqual({
      cost_usd: "0.000000", tokens_in: 0, tokens_out: 0, wallclock_ms: 0, budget_exceeded: false,
    });
  });
});

describe("agent_run, tool_call, run_checkpoint -- row level security", () => {
  it("is enabled and forced on all three tables", async () => {
    const r = await db.execute(
      sql`select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('agent_run', 'tool_call', 'run_checkpoint')`,
    );
    const rows = r.rows as unknown as { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname}.relrowsecurity`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname}.relforcerowsecurity`).toBe(true);
    }
  });

  it("a workspace B agent_run is invisible when scoped to workspace A", async () => {
    const marker = `agent-run-B-only ${Date.now()}-${Math.random()}`;
    const runId = newId();
    await withTenant(pool, b.workspaceId, (tx) =>
      tx.query(
        `insert into agent_run (id,workspace_id,agent_version_id,campaign_id,state,prompt_version,model_version)
         values ($1,$2,$3,$4,'pending',$5,'m1')`,
        [runId, b.workspaceId, b.agentVersionId, b.campaignId, marker],
      ));
    createdRunIds.push(runId);

    const seenFromA = await withTenant(pool, a.workspaceId, (tx) =>
      tx.query("select count(*)::int as n from agent_run where prompt_version = $1", [marker]));
    expect(seenFromA.rows[0].n).toBe(0);

    const seenFromB = await withTenant(pool, b.workspaceId, (tx) =>
      tx.query("select count(*)::int as n from agent_run where prompt_version = $1", [marker]));
    expect(seenFromB.rows[0].n).toBe(1);
  });

  it("an agent_run insert tagged with workspace B is refused while scoped to workspace A", async () => {
    const marker = `agent-run-cross ${Date.now()}-${Math.random()}`;
    await expect(
      withTenant(pool, a.workspaceId, (tx) =>
        tx.query(
          `insert into agent_run (id,workspace_id,agent_version_id,campaign_id,state,prompt_version,model_version)
           values (gen_random_uuid(),$1,$2,$3,'pending',$4,'m1')`,
          [b.workspaceId, a.agentVersionId, a.campaignId, marker],
        )),
    ).rejects.toThrow(/new row violates row-level security policy for table "agent_run"/);
  });

  it("a tool_call insert tagged with workspace B is refused while scoped to workspace A", async () => {
    const runId = newId();
    await withTenant(pool, a.workspaceId, (tx) =>
      tx.query(
        `insert into agent_run (id,workspace_id,agent_version_id,campaign_id,state,prompt_version,model_version)
         values ($1,$2,$3,$4,'pending','p1','m1')`,
        [runId, a.workspaceId, a.agentVersionId, a.campaignId],
      ));
    createdRunIds.push(runId);

    await expect(
      withTenant(pool, a.workspaceId, (tx) =>
        tx.query(
          `insert into tool_call (id,workspace_id,agent_run_id,tool_name,allowed)
           values (gen_random_uuid(),$1,$2,'read_campaign',true)`,
          [b.workspaceId, runId],
        )),
    ).rejects.toThrow(/new row violates row-level security policy for table "tool_call"/);
  });

  it("a run_checkpoint insert tagged with workspace B is refused while scoped to workspace A", async () => {
    const runId = newId();
    await withTenant(pool, a.workspaceId, (tx) =>
      tx.query(
        `insert into agent_run (id,workspace_id,agent_version_id,campaign_id,state,prompt_version,model_version)
         values ($1,$2,$3,$4,'pending','p1','m1')`,
        [runId, a.workspaceId, a.agentVersionId, a.campaignId],
      ));
    createdRunIds.push(runId);

    await expect(
      withTenant(pool, a.workspaceId, (tx) =>
        tx.query(
          `insert into run_checkpoint (id,workspace_id,agent_run_id,step_name)
           values (gen_random_uuid(),$1,$2,'prompt_built')`,
          [b.workspaceId, runId],
        )),
    ).rejects.toThrow(/new row violates row-level security policy for table "run_checkpoint"/);
  });
});

describe("agent_run.agent_version_id -> agent_version composite FK", () => {
  it("refuses an agent_run in workspace B pointing at workspace A's agent_version", async () => {
    await expect(
      withTenant(pool, b.workspaceId, (tx) =>
        tx.query(
          `insert into agent_run (id,workspace_id,agent_version_id,campaign_id,state,prompt_version,model_version)
           values (gen_random_uuid(),$1,$2,$3,'pending','p1','m1')`,
          [b.workspaceId, a.agentVersionId, b.campaignId],
        )),
    ).rejects.toThrow(/agent_run_agent_version_id_workspace_id_fkey/);
  });

  it("still allows an agent_run in workspace B pointing at workspace B's own agent_version", async () => {
    const runId = newId();
    await withTenant(pool, b.workspaceId, (tx) =>
      tx.query(
        `insert into agent_run (id,workspace_id,agent_version_id,campaign_id,state,prompt_version,model_version)
         values ($1,$2,$3,$4,'pending','p1','m1')`,
        [runId, b.workspaceId, b.agentVersionId, b.campaignId],
      ));
    createdRunIds.push(runId);
  });
});

describe("agent_run.campaign_id -> campaign composite FK", () => {
  it("refuses an agent_run in workspace B pointing at workspace A's campaign", async () => {
    await expect(
      withTenant(pool, b.workspaceId, (tx) =>
        tx.query(
          `insert into agent_run (id,workspace_id,agent_version_id,campaign_id,state,prompt_version,model_version)
           values (gen_random_uuid(),$1,$2,$3,'pending','p1','m1')`,
          [b.workspaceId, b.agentVersionId, a.campaignId],
        )),
    ).rejects.toThrow(/agent_run_campaign_id_workspace_id_fkey/);
  });
});

describe("tool_call.agent_run_id -> agent_run composite FK", () => {
  it("refuses a tool_call in workspace B pointing at workspace A's agent_run", async () => {
    await expect(
      withTenant(pool, b.workspaceId, (tx) =>
        tx.query(
          `insert into tool_call (id,workspace_id,agent_run_id,tool_name,allowed)
           values (gen_random_uuid(),$1,$2,'read_campaign',true)`,
          [b.workspaceId, a.agentRunId],
        )),
    ).rejects.toThrow(/tool_call_agent_run_id_workspace_id_fkey/);
  });

  it("still allows a tool_call in workspace B pointing at workspace B's own agent_run", async () => {
    await withTenant(pool, b.workspaceId, (tx) =>
      tx.query(
        `insert into tool_call (id,workspace_id,agent_run_id,tool_name,allowed)
         values (gen_random_uuid(),$1,$2,'read_campaign',true)`,
        [b.workspaceId, b.agentRunId],
      ));
  });
});

describe("run_checkpoint.agent_run_id -> agent_run composite FK", () => {
  it("refuses a run_checkpoint in workspace B pointing at workspace A's agent_run", async () => {
    await expect(
      withTenant(pool, b.workspaceId, (tx) =>
        tx.query(
          `insert into run_checkpoint (id,workspace_id,agent_run_id,step_name)
           values (gen_random_uuid(),$1,$2,'hijack_step')`,
          [b.workspaceId, a.agentRunId],
        )),
    ).rejects.toThrow(/run_checkpoint_agent_run_id_workspace_id_fkey/);
  });

  it("still allows a run_checkpoint in workspace B pointing at workspace B's own agent_run", async () => {
    await withTenant(pool, b.workspaceId, (tx) =>
      tx.query(
        `insert into run_checkpoint (id,workspace_id,agent_run_id,step_name)
         values (gen_random_uuid(),$1,$2,'legit_step')`,
        [b.workspaceId, b.agentRunId],
      ));
  });

  it("enforces UNIQUE (agent_run_id, step_name): a duplicate checkpoint step is refused", async () => {
    const runId = newId();
    await withTenant(pool, a.workspaceId, (tx) =>
      tx.query(
        `insert into agent_run (id,workspace_id,agent_version_id,campaign_id,state,prompt_version,model_version)
         values ($1,$2,$3,$4,'pending','p1','m1')`,
        [runId, a.workspaceId, a.agentVersionId, a.campaignId],
      ));
    createdRunIds.push(runId);

    await withTenant(pool, a.workspaceId, (tx) =>
      tx.query(
        `insert into run_checkpoint (id,workspace_id,agent_run_id,step_name) values (gen_random_uuid(),$1,$2,'prompt_built')`,
        [a.workspaceId, runId],
      ));

    await expect(
      withTenant(pool, a.workspaceId, (tx) =>
        tx.query(
          `insert into run_checkpoint (id,workspace_id,agent_run_id,step_name) values (gen_random_uuid(),$1,$2,'prompt_built')`,
          [a.workspaceId, runId],
        )),
    ).rejects.toThrow(/run_checkpoint_agent_run_id_step_name_key/);
  });
});

describe("smos_app privileges on the new tables", () => {
  it("has no DELETE grant on agent_run", async () => {
    const runId = newId();
    await withTenant(pool, a.workspaceId, (tx) =>
      tx.query(
        `insert into agent_run (id,workspace_id,agent_version_id,campaign_id,state,prompt_version,model_version)
         values ($1,$2,$3,$4,'pending','p1','m1')`,
        [runId, a.workspaceId, a.agentVersionId, a.campaignId],
      ));
    createdRunIds.push(runId);

    await expect(
      withTenant(pool, a.workspaceId, (tx) => tx.query(`delete from agent_run where id = $1`, [runId])),
    ).rejects.toThrow(/permission denied/i);
  });
});
