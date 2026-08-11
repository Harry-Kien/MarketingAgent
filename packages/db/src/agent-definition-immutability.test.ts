// Fix round 2 on Task 10. Fix round 1 (0013) closed the direct path: an
// agent_version can no longer be inserted or updated to activated=true for
// a non-M1 role. That report explicitly disclosed a residual: 0013's
// trigger lives on agent_version and only fires on writes to
// activated/agent_definition_id. Nothing stopped
// `UPDATE agent_definition SET role = 'integration_reliability'` on a
// definition that already has an activated=true agent_version pointing at
// it -- the version's own columns never change, so 0013 never re-fires,
// and the four-agent cost control is defeated through a door that looks
// nothing like the one already closed.
//
// 0014 closes it with a BEFORE UPDATE OF role trigger on agent_definition,
// column-selective exactly like publication_core_fields_immutable() in
// 0011_publication_immutability.sql. This file proves: the coordinator's
// exact attack (content -> integration_reliability) is refused; the same
// attack aimed at every other non-M1 role is refused; renaming into
// *another* M1 role is refused too (role is unconditionally immutable, not
// merely guarded against non-M1 targets); mission is still freely
// updatable so contract revisions are not blocked; the count of
// activated=true rows in a workspace still never exceeds four once all of
// the above attempts (plus the already-existing insert-time gate) have
// been tried against it.
//
// It also documents a "third door" search: whether repointing
// agent_version.agent_definition_id at a different definition defeats the
// rule (it does not -- 0013's trigger already re-fires on that column),
// whether DELETE + reinsert defeats it (it cannot -- smos_app was never
// granted DELETE on either table, confirmed empirically below), and
// whether `INSERT ... ON CONFLICT DO UPDATE SET role = ...` defeats the
// new trigger by going around a plain UPDATE statement (it does not --
// PostgreSQL fires column-selective UPDATE triggers for the DO UPDATE arm
// of ON CONFLICT exactly as for a normal UPDATE).
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

// Fresh, unused-elsewhere workspace ids.
const W3 = "cdcdcdcd-cdcd-7cdc-8cdc-cdcdcdcdcdcd";
const W4 = "12345678-1234-7123-8123-123456789abc";

const nonM1Roles = ALL_AGENT_ROLES.filter(
  (role) => !(M1_ACTIVATED_AGENTS as readonly string[]).includes(role),
);
const otherM1Roles = M1_ACTIVATED_AGENTS.filter((role) => role !== "content");

const createdVersionIds: string[] = [];
const createdDefinitionIds: string[] = [];

async function insertDefinition(ws: string, role: AgentRole, mission: string): Promise<string> {
  return withTenant(pool, ws, (tx) =>
    tx.query(
      `insert into agent_definition (id, workspace_id, role, mission) values (gen_random_uuid(), $1, $2, $3) returning id`,
      [ws, role, mission],
    ).then((r) => r.rows[0].id as string));
}

async function insertActivatedVersion(ws: string, definitionId: string, versionNumber: number): Promise<string> {
  return withTenant(pool, ws, (tx) =>
    tx.query(
      `insert into agent_version (id, workspace_id, agent_definition_id, version_number, activated, prompt_version, model_version, budget_usd)
       values (gen_random_uuid(), $1, $2, $3, true, 'p1', 'm1', 1.0) returning id`,
      [ws, definitionId, versionNumber],
    ).then((r) => r.rows[0].id as string));
}

let contentDefinitionId: string;
let contentVersionId: string;

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${W3}::uuid, 'agent-def-immutability-W3'), (${W4}::uuid, 'agent-def-immutability-W4') on conflict do nothing`,
  );

  // The coordinator's exact scenario: activate `content` legitimately.
  const marker = `agent-def-immutability content ${Date.now()}-${Math.random()}`;
  contentDefinitionId = await insertDefinition(W3, "content", marker);
  createdDefinitionIds.push(contentDefinitionId);
  contentVersionId = await insertActivatedVersion(W3, contentDefinitionId, 1);
  createdVersionIds.push(contentVersionId);
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

describe("agent_definition.role immutability", () => {
  it("refuses renaming an activated definition's role to a non-M1 role (the coordinator's exact attack: content -> integration_reliability)", async () => {
    await expect(
      withTenant(pool, W3, (tx) =>
        tx.query(`update agent_definition set role = 'integration_reliability' where id = $1`, [
          contentDefinitionId,
        ])),
    ).rejects.toThrow(/immutable/i);
  });

  it.each(nonM1Roles)("refuses renaming the activated `content` definition to %s", async (role) => {
    await expect(
      withTenant(pool, W3, (tx) =>
        tx.query(`update agent_definition set role = $1 where id = $2`, [role, contentDefinitionId])),
    ).rejects.toThrow(/immutable/i);
  });

  it.each(otherM1Roles)(
    "refuses renaming the activated `content` definition to another M1 role (%s) -- role is unconditionally immutable, not merely guarded against non-M1 targets",
    async (role) => {
      await expect(
        withTenant(pool, W3, (tx) =>
          tx.query(`update agent_definition set role = $1 where id = $2`, [role, contentDefinitionId])),
      ).rejects.toThrow(/immutable/i);
    },
  );

  it("still allows updating mission -- contract revisions are not blocked", async () => {
    const revisedMission = `revised mission ${Date.now()}-${Math.random()}`;
    await withTenant(pool, W3, (tx) =>
      tx.query(`update agent_definition set mission = $1 where id = $2`, [revisedMission, contentDefinitionId]));

    const r = await withTenant(pool, W3, (tx) =>
      tx.query(`select mission from agent_definition where id = $1`, [contentDefinitionId]));
    expect(r.rows[0].mission).toBe(revisedMission);
  });

  it("the definition's role is still `content` after every refused rename attempt", async () => {
    const r = await withTenant(pool, W3, (tx) =>
      tx.query(`select role from agent_definition where id = $1`, [contentDefinitionId]));
    expect(r.rows[0].role).toBe("content");
  });
});

describe("third door: agent_version.agent_definition_id repoint", () => {
  it("repointing an activated version at a different definition is refused (already closed by 0013's UPDATE OF agent_definition_id trigger)", async () => {
    const marker = `agent-def-immutability seo_aeo ${Date.now()}-${Math.random()}`;
    const otherDefinitionId = await insertDefinition(W3, "seo_aeo", marker);
    createdDefinitionIds.push(otherDefinitionId);

    await expect(
      withTenant(pool, W3, (tx) =>
        tx.query(`update agent_version set agent_definition_id = $1 where id = $2`, [
          otherDefinitionId,
          contentVersionId,
        ])),
    ).rejects.toThrow(/M1|activated/i);
  });
});

describe("third door: DELETE + reinsert under the same id", () => {
  it("smos_app has no DELETE privilege on agent_definition or agent_version", async () => {
    const r = await db.execute(
      sql`select relname, has_table_privilege('smos_app', relname, 'DELETE') as can_delete
          from pg_class where relname in ('agent_definition', 'agent_version')`,
    );
    const rows = r.rows as { relname: string; can_delete: boolean }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.can_delete).toBe(false);
    }
  });

  it("a DELETE on an activated definition is refused (permission denied, not RLS)", async () => {
    await expect(
      withTenant(pool, W3, (tx) => tx.query(`delete from agent_definition where id = $1`, [contentDefinitionId])),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("third door: INSERT ... ON CONFLICT DO UPDATE SET role", () => {
  it("an upsert that targets role in its DO UPDATE clause is refused by the same trigger", async () => {
    await expect(
      withTenant(pool, W3, (tx) =>
        tx.query(
          `insert into agent_definition (id, workspace_id, role, mission)
           values (gen_random_uuid(), $1, 'content', 'upsert probe')
           on conflict (workspace_id, role) do update set role = excluded.role`,
          [W3],
        )),
    ).rejects.toThrow(/immutable/i);
  });
});

describe("regression: activated=true count still never exceeds four after every attack above", () => {
  it("count stays at 4 in a fresh workspace after the legit four activations, a role-rename attack, and a refused 5th activation", async () => {
    const definitionByRole = new Map<AgentRole, string>();
    for (const role of M1_ACTIVATED_AGENTS) {
      const marker = `agent-def-immutability-count ${role} ${Date.now()}-${Math.random()}`;
      const defId = await insertDefinition(W4, role, marker);
      createdDefinitionIds.push(defId);
      definitionByRole.set(role, defId);
      const versionId = await insertActivatedVersion(W4, defId, 1);
      createdVersionIds.push(versionId);
    }

    // Attack 1: try to rename one of the four legitimately-activated
    // definitions into a non-M1 role.
    const contentDefId = definitionByRole.get("content")!;
    await expect(
      withTenant(pool, W4, (tx) =>
        tx.query(`update agent_definition set role = 'integration_reliability' where id = $1`, [contentDefId])),
    ).rejects.toThrow(/immutable/i);

    // Attack 2 (already closed in fix round 1): insert a 5th activated
    // version for a non-M1 role.
    const fifthMarker = `agent-def-immutability-count fifth ${Date.now()}-${Math.random()}`;
    const fifthDefId = await insertDefinition(W4, "paid_media_advisor", fifthMarker);
    createdDefinitionIds.push(fifthDefId);
    await expect(
      withTenant(pool, W4, (tx) =>
        tx.query(
          `insert into agent_version (id, workspace_id, agent_definition_id, version_number, activated, prompt_version, model_version, budget_usd)
           values (gen_random_uuid(), $1, $2, 1, true, 'p1', 'm1', 1.0)`,
          [W4, fifthDefId],
        )),
    ).rejects.toThrow(/M1|activated/i);

    const count = await withTenant(pool, W4, (tx) =>
      tx.query("select count(*)::int as n from agent_version where workspace_id = $1 and activated = true", [W4]));
    expect(count.rows[0].n).toBeLessThanOrEqual(4);
    expect(count.rows[0].n).toBe(4);
  });
});
