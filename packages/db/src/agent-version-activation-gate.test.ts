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

  // Final whole-branch review, FINDING 1 (HIGH). agent_version_m1_activation_gate()
  // is SECURITY INVOKER with no pinned search_path, and its lookup of
  // agent_definition is unqualified. A plain smos_app session, inside an
  // otherwise correctly RLS-scoped transaction, can create its own
  // agent_definition-shaped decoy table in a schema placed ahead of public
  // on search_path, and the gate's unqualified `FROM agent_definition`
  // resolves to the decoy instead of the real table -- reporting whatever
  // role the attacker wants (e.g. 'content', an M1 role) regardless of the
  // real agent_definition's actual role. Fixed by pinning
  // `SET search_path = public` on the function (and audited onto every
  // other function this branch created -- see the fix migration).
  //
  // Deliberately uses the pre-existing `pgboss` schema as the decoy
  // location, not a freshly `CREATE SCHEMA`'d one: after
  // 0020_pgboss_revoke_database_create.sql, smos_app can no longer CREATE
  // SCHEMA at all (finding 2 closed that door), which could make it look
  // like finding 1 was accidentally fixed as a side effect. It was not --
  // smos_app still owns `pgboss` (0003_pgboss_schema_owner.sql) and can
  // always CREATE a table inside a schema it owns, with no database-level
  // privilege required. The reviewer's own finding says exactly this: "The
  // same works using the pgboss schema smos_app owns, so revoking CREATE ON
  // DATABASE alone does not fix it" -- this is that reproduction, run after
  // finding 2's fix is in place, to prove finding 1's fix (not finding 2's)
  // is what actually closes it.
  it("a decoy agent_definition-shaped table inside the pgboss schema smos_app owns cannot forge the gate's role lookup", async () => {
    const definitionId = definitionIdByRole.get("integration_reliability")!;

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role smos_app");
      await client.query("select set_config('app.workspace_id', $1, true)", [W]);

      // smos_app owns `pgboss` (0003), so it can CREATE inside it with no
      // database-level privilege at all -- exactly the door finding 2's fix
      // leaves open on purpose (pg-boss itself needs it) and finding 1 must
      // not rely on it being closed. pg-boss has no table of its own
      // literally named `agent_definition`, so this cannot collide with
      // real pg-boss infrastructure, and DDL is transactional -- the whole
      // thing is rolled back below regardless of outcome.
      await client.query(`create table pgboss.agent_definition (id uuid, workspace_id uuid, role text)`);
      await client.query(
        `insert into pgboss.agent_definition (id, workspace_id, role) values ($1, $2, 'content')`,
        [definitionId, W],
      );
      await client.query(`set search_path = pgboss, public`);

      await expect(
        client.query(
          `insert into agent_version (id, workspace_id, agent_definition_id, version_number, activated, prompt_version, model_version, budget_usd)
           values (gen_random_uuid(), $1, $2, 4, true, 'p1', 'm1', 1.0)`,
          [W, definitionId],
        ),
      ).rejects.toThrow(/M1|activated/i);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }

    // DDL is transactional, so the decoy table above was rolled back with
    // everything else, but drop defensively in case a future refactor makes
    // any of this outlive the transaction -- pgboss is shared, real
    // infrastructure and must never carry test debris.
    await adminPool.query(`drop table if exists pgboss.agent_definition`).catch(() => undefined);
  });
});
