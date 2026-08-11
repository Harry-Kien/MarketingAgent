// Fix round 1 on Task 10. Adversarial review reproduced live: inserting
// agent_version(role effectively 'integration_reliability', activated=true)
// directly as smos_app, inside a properly RLS-scoped transaction, succeeded
// with no error -- nothing in 0012_agent_registry.sql limited which roles,
// or how many, could ever be marked activated. 0013 closes that with a
// trigger on agent_version (see that migration's header for why a trigger
// and not a denormalised column). This file proves the fix: the reviewer's
// exact reproduction is refused, every other non-M1 role is refused the
// same way, all four M1 roles can still be activated, a non-M1 role can
// still be registered inactive (all fifteen contracts must exist), and the
// count of activated=true rows in a workspace never exceeds four.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ALL_AGENT_ROLES, M1_ACTIVATED_AGENTS, type AgentRole } from "@smos/domain";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);

const adminUrl =
  process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);

// Fresh, unused-elsewhere workspace ids -- distinct from every other test
// file's fixtures so agent_definition's UNIQUE (workspace_id, role) can
// never collide across files sharing this persistent database.
const W = "99999999-9999-7999-8999-999999999999";
const W2 = "abababab-abab-7aba-8aba-abababababab";

const nonM1Roles = ALL_AGENT_ROLES.filter(
  (role) => !(M1_ACTIVATED_AGENTS as readonly string[]).includes(role),
);

const createdVersionIds: string[] = [];
const createdDefinitionIds: string[] = [];
const definitionIdByRole = new Map<AgentRole, string>();

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${W}::uuid, 'agent-version-gate-W'), (${W2}::uuid, 'agent-version-gate-W2') on conflict do nothing`,
  );

  // One agent_definition per role in W, reused by every test below.
  await withTenant(pool, W, async (tx) => {
    for (const role of ALL_AGENT_ROLES) {
      const marker = `agent-version-gate ${role} ${Date.now()}-${Math.random()}`;
      const r = await tx.query(
        `insert into agent_definition (id, workspace_id, role, mission) values (gen_random_uuid(), $1, $2, $3) returning id`,
        [W, role, marker],
      );
      const id = r.rows[0].id as string;
      definitionIdByRole.set(role, id);
      createdDefinitionIds.push(id);
    }
  });
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

describe("agent_version M1 activation gate", () => {
  it.each(nonM1Roles)("refuses activating a non-M1 role: %s", async (role) => {
    const definitionId = definitionIdByRole.get(role)!;
    await expect(
      withTenant(pool, W, (tx) =>
        tx.query(
          `insert into agent_version (id, workspace_id, agent_definition_id, version_number, activated, prompt_version, model_version, budget_usd)
           values (gen_random_uuid(), $1, $2, 1, true, 'p1', 'm1', 1.0)`,
          [W, definitionId],
        )),
    ).rejects.toThrow(/M1|activated/i);
  });

  it.each([...M1_ACTIVATED_AGENTS])("still allows activating M1 role: %s", async (role) => {
    const definitionId = definitionIdByRole.get(role as AgentRole)!;
    const versionId = await withTenant(pool, W, (tx) =>
      tx.query(
        `insert into agent_version (id, workspace_id, agent_definition_id, version_number, activated, prompt_version, model_version, budget_usd)
         values (gen_random_uuid(), $1, $2, 1, true, 'p1', 'm1', 1.0) returning id`,
        [W, definitionId],
      ).then((r) => r.rows[0].id as string));
    createdVersionIds.push(versionId);
  });

  it("still allows registering a non-M1 role with activated = false", async () => {
    const definitionId = definitionIdByRole.get("cro_experiment")!;
    const versionId = await withTenant(pool, W, (tx) =>
      tx.query(
        `insert into agent_version (id, workspace_id, agent_definition_id, version_number, activated, prompt_version, model_version, budget_usd)
         values (gen_random_uuid(), $1, $2, 2, false, 'p1', 'm1', 1.0) returning id`,
        [W, definitionId],
      ).then((r) => r.rows[0].id as string));
    createdVersionIds.push(versionId);
  });

  it("an UPDATE that flips activated to true on a non-M1 role is refused too", async () => {
    const definitionId = definitionIdByRole.get("data_analyst")!;
    const versionId = await withTenant(pool, W, (tx) =>
      tx.query(
        `insert into agent_version (id, workspace_id, agent_definition_id, version_number, activated, prompt_version, model_version, budget_usd)
         values (gen_random_uuid(), $1, $2, 3, false, 'p1', 'm1', 1.0) returning id`,
        [W, definitionId],
      ).then((r) => r.rows[0].id as string));
    createdVersionIds.push(versionId);

    await expect(
      withTenant(pool, W, (tx) =>
        tx.query(`update agent_version set activated = true where id = $1`, [versionId])),
    ).rejects.toThrow(/M1|activated/i);
  });

  it("the count of activated = true rows in a workspace never exceeds four", async () => {
    // Each step below is its own withTenant call, deliberately: a query
    // that errors aborts the whole PostgreSQL transaction it runs in, so
    // the failing 5th insert cannot share a transaction with the four
    // successful ones above it -- it would abort that transaction and the
    // outer withTenant's own COMMIT would then throw, uncaught, once
    // control returns from the failing statement.
    for (const role of M1_ACTIVATED_AGENTS) {
      const marker = `agent-version-gate-count ${role} ${Date.now()}-${Math.random()}`;
      const { defId, versionId } = await withTenant(pool, W2, async (tx) => {
        const def = await tx.query(
          `insert into agent_definition (id, workspace_id, role, mission) values (gen_random_uuid(), $1, $2, $3) returning id`,
          [W2, role, marker],
        );
        const id = def.rows[0].id as string;
        const version = await tx.query(
          `insert into agent_version (id, workspace_id, agent_definition_id, version_number, activated, prompt_version, model_version, budget_usd)
           values (gen_random_uuid(), $1, $2, 1, true, 'p1', 'm1', 1.0) returning id`,
          [W2, id],
        );
        return { defId: id, versionId: version.rows[0].id as string };
      });
      createdDefinitionIds.push(defId);
      createdVersionIds.push(versionId);
    }

    const fifthMarker = `agent-version-gate-count fifth ${Date.now()}-${Math.random()}`;
    const fifthDefId = await withTenant(pool, W2, (tx) =>
      tx.query(
        `insert into agent_definition (id, workspace_id, role, mission) values (gen_random_uuid(), $1, 'integration_reliability', $2) returning id`,
        [W2, fifthMarker],
      ).then((r) => r.rows[0].id as string));
    createdDefinitionIds.push(fifthDefId);

    await expect(
      withTenant(pool, W2, (tx) =>
        tx.query(
          `insert into agent_version (id, workspace_id, agent_definition_id, version_number, activated, prompt_version, model_version, budget_usd)
           values (gen_random_uuid(), $1, $2, 1, true, 'p1', 'm1', 1.0)`,
          [W2, fifthDefId],
        )),
    ).rejects.toThrow(/M1|activated/i);

    const count = await withTenant(pool, W2, (tx) =>
      tx.query("select count(*)::int as n from agent_version where workspace_id = $1 and activated = true", [W2]));
    expect(count.rows[0].n).toBeLessThanOrEqual(4);
    expect(count.rows[0].n).toBe(4);
  });
});
