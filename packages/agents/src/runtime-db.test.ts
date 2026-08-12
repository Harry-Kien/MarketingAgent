// End-to-end proof, wired against the real database: runAgent (T7) driving
// the real Postgres-backed RunStore (packages/db/src/repositories/
// run-store.ts) -- not a mock -- through T5's parseAgentOutput boundary.
// This is the "keystone" claim task-7-brief.md's own framing makes: T1
// (fake provider), T2 (budget), T4 (tool registry, passed through even
// though this task never calls it), T5 (parseAgentOutput), T6 (schema),
// P1 (assertActivated + the database activation gate this task adds in
// 0025) all have to actually compose for these three tests to pass.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ALL_AGENT_ROLES,
  M1_ACTIVATED_AGENTS,
  newId,
  AgentNotActivatedError,
  type AgentRegistryEntry,
} from "@smos/domain";
import { createFakeProvider, createGateway } from "@smos/model-gateway";
import { contentOutputSchema, parseAgentOutput } from "@smos/contracts";
import { createDbPool, createRunStore } from "@smos/db";
import { runAgent } from "./runtime.ts";
import { createToolRegistry } from "./tools.ts";

const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);

const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);

const workspaceId = newId();
const goalId = newId();
const campaignId = newId();
const agentDefId = newId();
const agentVersionId = newId();

beforeAll(async () => {
  await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [
    workspaceId,
    `t7-runtime-db-${workspaceId}`,
  ]);
  await adminPool.query(`insert into goal (id, workspace_id, statement) values ($1, $2, 't7 e2e seed goal')`, [
    goalId,
    workspaceId,
  ]);
  await adminPool.query(
    `insert into campaign (id, workspace_id, goal_id, name, state) values ($1, $2, $3, $4, 'DRAFT')`,
    [campaignId, workspaceId, goalId, `t7-runtime-db-campaign-${campaignId}`],
  );
  await adminPool.query(
    `insert into agent_definition (id, workspace_id, role, mission) values ($1, $2, 'content', 't7 e2e seed')`,
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
    const runs = await adminPool.query(`select id from agent_run where workspace_id = $1`, [workspaceId]);
    const runIds = runs.rows.map((r: { id: string }) => r.id);
    if (runIds.length > 0) {
      await adminPool.query(`delete from tool_call where agent_run_id = ANY($1::uuid[])`, [runIds]);
      await adminPool.query(`delete from run_checkpoint where agent_run_id = ANY($1::uuid[])`, [runIds]);
      await adminPool.query(`delete from agent_run where id = ANY($1::uuid[])`, [runIds]);
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

const registryWith = (activated: boolean): AgentRegistryEntry[] =>
  ALL_AGENT_ROLES.map((role) => ({
    role,
    versionId: role === "content" ? agentVersionId : newId(),
    activated: role === "content" ? activated : (M1_ACTIVATED_AGENTS as readonly string[]).includes(role),
    toolAllowlist: [],
    prohibitedActions: [],
  }));

describe("runAgent + the real RunStore, end to end", () => {
  it("success: persists validated output atomically with the terminal state, in the real database", async () => {
    const validOutput = { body: "hello world", publicationContent: "hello world", claimsUsed: [] };
    const result = await runAgent({
      role: "content",
      registry: registryWith(true),
      gateway: createGateway({
        provider: createFakeProvider({ "content.v1": JSON.stringify(validOutput) }),
        budgetUsd: 1,
        maxWallclockMs: 5000,
        estimatedCostUsd: 0.05,
      }),
      tools: createToolRegistry([]),
      workspaceId,
      campaignId,
      correlationId: newId(),
      buildPrompt: () => ({ system: "s", input: "i", schemaName: "content.v1" }),
      parse: (raw) => parseAgentOutput(contentOutputSchema, raw),
      store: createRunStore(pool, workspaceId),
    });

    expect(result.output).toEqual(validOutput);

    const run = await adminPool.query(`select state from agent_run where id = $1`, [result.runId]);
    expect(run.rows[0].state).toBe("succeeded");

    const cp = await adminPool.query(
      `select state_blob from run_checkpoint where agent_run_id = $1 and step_name = 'output_persisted'`,
      [result.runId],
    );
    expect(cp.rows[0].state_blob).toEqual({ output: validOutput });
  });

  it("parse failure: agent_run ends failed_terminal in the database, and no output is ever persisted", async () => {
    let caughtRunId: string | undefined;
    const s = {
      ...createRunStore(pool, workspaceId),
    };
    // Wrap createRun to capture the id without needing the caller to see it
    // (runAgent rejects, so RunAgentResult.runId is never returned).
    const originalCreateRun = s.createRun.bind(s);
    s.createRun = async (r) => {
      const id = await originalCreateRun(r);
      caughtRunId = id;
      return id;
    };

    await expect(
      runAgent({
        role: "content",
        registry: registryWith(true),
        gateway: createGateway({
          provider: createFakeProvider({ "content.v1": "this is not json" }),
          budgetUsd: 1,
          maxWallclockMs: 5000,
          estimatedCostUsd: 0.05,
        }),
        tools: createToolRegistry([]),
        workspaceId,
        campaignId,
        correlationId: newId(),
        buildPrompt: () => ({ system: "s", input: "i", schemaName: "content.v1" }),
        parse: (raw) => parseAgentOutput(contentOutputSchema, raw),
        store: s,
      }),
    ).rejects.toThrow(/not valid JSON/i);

    expect(caughtRunId).toBeDefined();
    const run = await adminPool.query(`select state from agent_run where id = $1`, [caughtRunId]);
    expect(run.rows[0].state).toBe("failed_terminal");

    const cp = await adminPool.query(
      `select 1 from run_checkpoint where agent_run_id = $1 and step_name = 'output_persisted'`,
      [caughtRunId],
    );
    expect(cp.rowCount).toBe(0);
  });

  it("non-activated role: no agent_run row is ever created, and the database's own activation gate would refuse it independently", async () => {
    const before = await adminPool.query(`select count(*)::int as n from agent_run where workspace_id = $1`, [
      workspaceId,
    ]);

    await expect(
      runAgent({
        role: "content",
        registry: registryWith(false), // this workspace's content agent_version really is activated=false in the DB below
        gateway: createGateway({ provider: { name: "spy", generate: async () => { throw new Error("must never be called"); } }, budgetUsd: 1, maxWallclockMs: 100, estimatedCostUsd: 0.05 }),
        tools: createToolRegistry([]),
        workspaceId,
        campaignId,
        correlationId: newId(),
        buildPrompt: () => ({ system: "s", input: "i", schemaName: "content.v1" }),
        parse: (raw) => parseAgentOutput(contentOutputSchema, raw),
        store: createRunStore(pool, workspaceId),
      }),
    ).rejects.toThrow(AgentNotActivatedError);

    const after = await adminPool.query(`select count(*)::int as n from agent_run where workspace_id = $1`, [
      workspaceId,
    ]);
    expect(after.rows[0].n).toBe(before.rows[0].n);

    // Flip the SAME agent_version's activated flag to false in the real
    // database (it was seeded activated=true in beforeAll) and prove the
    // database's own 0025 trigger refuses a direct insert too -- the
    // TypeScript-level check above and the database-level check are two
    // independent layers, not one masquerading as two. @smos/db
    // deliberately does not export withTenant/TenantTx publicly (see
    // packages/db/src/tool-tx.ts's header -- that boundary applies just as
    // much to this package as to a tool body), so this reaches for `pool`
    // directly with the same raw set_config pattern
    // packages/agents/src/tools-tenant.test.ts already uses for seeding.
    await adminPool.query(`update agent_version set activated = false where id = $1`, [agentVersionId]);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role smos_app");
      await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
      await expect(
        client.query(
          `insert into agent_run (id,workspace_id,agent_version_id,campaign_id,state,prompt_version,model_version)
           values ($1,$2,$3,$4,'pending','p1','m1')`,
          [newId(), workspaceId, agentVersionId, campaignId],
        ),
      ).rejects.toThrow(/not activated/i);
      await client.query("rollback");
    } finally {
      client.release();
      await adminPool.query(`update agent_version set activated = true where id = $1`, [agentVersionId]);
    }
  });

  // Fix round 1, IMPORTANT: proves tool dispatch end to end against the
  // real database, not the mock store -- a refused tool call must actually
  // land a row in tool_call (T6), not just call a mock's recordToolCall.
  it("a refused tool call is recorded in the real tool_call table, and the run still ends failed_terminal", async () => {
    const publish = vi.fn();
    const tools = createToolRegistry([{ name: "publish.meta", handler: publish }]);
    const registryNoTools = registryWith(true).map((e) => ({ ...e, toolAllowlist: [] }));

    const result = await runAgent({
      role: "content",
      registry: registryNoTools,
      gateway: createGateway({
        provider: createFakeProvider({ "content.v1": '{"toolCall":true}' }),
        budgetUsd: 1,
        maxWallclockMs: 5000,
        estimatedCostUsd: 0.05,
      }),
      tools,
      workspaceId,
      campaignId,
      correlationId: newId(),
      buildPrompt: () => ({ system: "s", input: "i", schemaName: "content.v1" }),
      parse: (raw) => parseAgentOutput(contentOutputSchema, raw),
      interpretToolCall: () => ({ name: "publish.meta", args: {} }),
      store: createRunStore(pool, workspaceId),
    }).catch((error: unknown) => {
      expect(String(error)).toMatch(/not on the tool allowlist/i);
      return undefined;
    });
    expect(result).toBeUndefined();
    expect(publish).not.toHaveBeenCalled();

    const runs = await adminPool.query(
      `select id, state from agent_run where workspace_id = $1 order by created_at desc limit 1`,
      [workspaceId],
    );
    expect(runs.rows[0].state).toBe("failed_terminal");

    const calls = await adminPool.query(
      `select tool_name, allowed from tool_call where agent_run_id = $1`,
      [runs.rows[0].id],
    );
    expect(calls.rows).toEqual([{ tool_name: "publish.meta", allowed: false }]);
  });
});
