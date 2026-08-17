// Fix round 3 on Task 10. Rounds 1 (0013) and 2 (0014) closed every path
// that lets a NON-M1 role become activated. The reviewer confirmed both
// hold, then found a third door that does not activate a new role at all:
// nothing limited how many activated VERSIONS a single agent_definition may
// have. Inserting a second agent_version(activated=true) under an
// already-legitimately-activated `orchestrator` definition succeeded,
// pushing the activated row count to six. No new role runs, but two things
// break: the "at most four activated rows" count invariant, and -- the one
// that costs money -- P2 dispatches by role with no dedup by definition, so
// two activated versions of the same role mean that role can be dispatched
// twice, calling a paid model provider twice for one logical run.
//
// 0015 closes it with a partial unique index:
//   CREATE UNIQUE INDEX ... ON agent_version (agent_definition_id) WHERE activated;
// This file proves: the reviewer's exact reproduction (second
// activated=true insert) is refused; an UPDATE that flips a second version
// to activated=true is refused the same way; an inactive second version can
// still be inserted (version history must remain possible); the legitimate
// swap workflow (deactivate the old version, then activate the new one, in
// one transaction) still works; and a strengthened count assertion --
// exactly four activated rows, and no single definition holding more than
// one of them -- would have caught this class of bug.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { M1_ACTIVATED_AGENTS, type AgentRole } from "@smos/domain";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);

const adminUrl =
  process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);

// Fresh, unused-elsewhere workspace ids.
const W5 = "56565656-5656-7565-8565-565656565656";
const W6 = "78787878-7878-7787-8878-787878787878";

const createdVersionIds: string[] = [];
const createdDefinitionIds: string[] = [];

async function insertDefinition(ws: string, role: AgentRole, mission: string): Promise<string> {
  const id = await withTenant(pool, ws, (tx) =>
    tx.query(
      `insert into agent_definition (id, workspace_id, role, mission) values (gen_random_uuid(), $1, $2, $3) returning id`,
      [ws, role, mission],
    ).then((r) => r.rows[0].id as string));
  createdDefinitionIds.push(id);
  return id;
}

async function insertVersion(
  ws: string,
  definitionId: string,
  versionNumber: number,
  activated: boolean,
): Promise<string> {
  const id = await withTenant(pool, ws, (tx) =>
    tx.query(
      `insert into agent_version (id, workspace_id, agent_definition_id, version_number, activated, prompt_version, model_version, budget_usd)
       values (gen_random_uuid(), $1, $2, $3, $4, 'p1', 'm1', 1.0) returning id`,
      [ws, definitionId, versionNumber, activated],
    ).then((r) => r.rows[0].id as string));
  createdVersionIds.push(id);
  return id;
}

let orchestratorDefId: string;
let orchestratorV1Id: string;

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${W5}::uuid, 'agent-version-single-activation-W5'), (${W6}::uuid, 'agent-version-single-activation-W6') on conflict do nothing`,
  );

  const marker = `agent-version-single-activation orchestrator ${Date.now()}-${Math.random()}`;
  orchestratorDefId = await insertDefinition(W5, "orchestrator", marker);
  orchestratorV1Id = await insertVersion(W5, orchestratorDefId, 1, true);
});

afterAll(async () => {
  if (createdVersionIds.length > 0) {
    await adminPool.query(`delete from agent_version where id = ANY($1::uuid[])`, [createdVersionIds]);
  }
  if (createdDefinitionIds.length > 0) {
    await adminPool.query(`delete from agent_definition where id = ANY($1::uuid[])`, [createdDefinitionIds]);
  }
  await pool.end();
  await adminPool.end();
});

describe("agent_version: at most one activated version per definition", () => {
  it("refuses inserting a second activated=true version under an already-activated definition (the reviewer's exact reproduction)", async () => {
    await expect(
      withTenant(pool, W5, (tx) =>
        tx.query(
          `insert into agent_version (id, workspace_id, agent_definition_id, version_number, activated, prompt_version, model_version, budget_usd)
           values (gen_random_uuid(), $1, $2, 2, true, 'p1', 'm1', 1.0)`,
          [W5, orchestratorDefId],
        )),
    ).rejects.toThrow(/agent_version_one_activated_per_definition/);
  });

  it("refuses UPDATE ... SET activated = true on a second version of an already-activated definition", async () => {
    const v3 = await insertVersion(W5, orchestratorDefId, 3, false);
    await expect(
      withTenant(pool, W5, (tx) => tx.query(`update agent_version set activated = true where id = $1`, [v3])),
    ).rejects.toThrow(/agent_version_one_activated_per_definition/);
  });

  it("an inactive second version can still be inserted -- version history must remain possible", async () => {
    await insertVersion(W5, orchestratorDefId, 4, false);
  });

  it("a legitimate version swap inside one transaction succeeds: deactivate v1, activate v2", async () => {
    const v5 = await insertVersion(W5, orchestratorDefId, 5, false);

    // The recommended workflow, in a single transaction: deactivate the
    // outgoing version FIRST, then activate the incoming one. Reversing the
    // order (activate before deactivate) would have both rows active for
    // agent_definition_id = orchestratorDefId at once, however briefly,
    // which the partial unique index -- not deferrable, since PostgreSQL
    // only supports DEFERRABLE on constraints added via
    // ALTER TABLE ... ADD CONSTRAINT, and partial uniqueness can only be
    // expressed as a bare CREATE UNIQUE INDEX -- rejects immediately.
    await withTenant(pool, W5, async (tx) => {
      await tx.query(`update agent_version set activated = false where id = $1`, [orchestratorV1Id]);
      await tx.query(`update agent_version set activated = true where id = $1`, [v5]);
    });

    const active = await withTenant(pool, W5, (tx) =>
      tx.query(`select id from agent_version where agent_definition_id = $1 and activated = true`, [
        orchestratorDefId,
      ]));
    expect(active.rows).toHaveLength(1);
    expect(active.rows[0].id).toBe(v5);
  });
});

describe("regression: exactly four activated rows, no definition holds more than one", () => {
  it("count is exactly 4 and no definition has a duplicate activated version, after a duplicate-insert attack and an update-flip attack", async () => {
    const definitionByRole = new Map<AgentRole, string>();
    for (const role of M1_ACTIVATED_AGENTS) {
      const marker = `agent-version-single-activation-count ${role} ${Date.now()}-${Math.random()}`;
      const defId = await insertDefinition(W6, role, marker);
      definitionByRole.set(role, defId);
      await insertVersion(W6, defId, 1, true);
    }

    // Attack 1: the reviewer's exact reproduction, against `content` here.
    const contentDefId = definitionByRole.get("content")!;
    await expect(
      withTenant(pool, W6, (tx) =>
        tx.query(
          `insert into agent_version (id, workspace_id, agent_definition_id, version_number, activated, prompt_version, model_version, budget_usd)
           values (gen_random_uuid(), $1, $2, 2, true, 'p1', 'm1', 1.0)`,
          [W6, contentDefId],
        )),
    ).rejects.toThrow(/agent_version_one_activated_per_definition/);

    // Attack 2: update-flip, against `research`.
    const researchDefId = definitionByRole.get("research")!;
    const researchV2 = await insertVersion(W6, researchDefId, 2, false);
    await expect(
      withTenant(pool, W6, (tx) =>
        tx.query(`update agent_version set activated = true where id = $1`, [researchV2])),
    ).rejects.toThrow(/agent_version_one_activated_per_definition/);

    const count = await withTenant(pool, W6, (tx) =>
      tx.query("select count(*)::int as n from agent_version where workspace_id = $1 and activated = true", [W6]));
    expect(count.rows[0].n).toBe(4);

    const dupes = await withTenant(pool, W6, (tx) =>
      tx.query(
        `select agent_definition_id, count(*)::int as n from agent_version
         where workspace_id = $1 and activated = true
         group by agent_definition_id having count(*) > 1`,
        [W6],
      ));
    expect(dupes.rows).toHaveLength(0);
  });
});
