// Task 10. agent_definition and agent_version are workspace-owned per
// ADR-007 (RLS ENABLED and FORCED, a policy carrying both USING and WITH
// CHECK). agent_version.agent_definition_id -> agent_definition is exactly
// the FK pattern 0008_composite_tenant_fk.sql fixed for every earlier
// parent/child pair: PostgreSQL evaluates a foreign key against the
// referenced table with RLS bypassed entirely, so a single-column FK would
// only prove *some* agent_definition with that id exists anywhere, never
// that it belongs to the same workspace. This file proves, for the two new
// tables: rows are RLS-enabled/forced, cross-workspace reads are invisible,
// cross-workspace inserts are refused, the composite FK refuses a
// cross-workspace parent reference while still allowing a same-workspace
// one, and the two positive-value CHECKs (budget_usd, version_number) hold.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);

const adminUrl =
  process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);

const A = "eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee";
const B = "ffffffff-ffff-7fff-8fff-ffffffffffff";

// This runs against a real, persistent PostgreSQL database with no
// per-test truncation, so every row this file inserts is tracked here and
// deleted in afterAll -- a fixed literal name would also accumulate extra
// rows across repeated runs, so every marker below carries a
// Date.now()/Math.random() suffix too.
const createdVersionIds: string[] = [];
const createdDefinitionIds: string[] = [];

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${A}::uuid, 'agent-registry-tenant-A'), (${B}::uuid, 'agent-registry-tenant-B') on conflict do nothing`,
  );
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

describe("agent_definition / agent_version — row level security", () => {
  it("is enabled and forced on both tables", async () => {
    const r = await db.execute(
      sql`select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('agent_definition', 'agent_version')`,
    );
    const rows = r.rows as { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });
});

describe("tenant isolation", () => {
  it("an agent_definition and agent_version belonging to workspace B are invisible when scoped to workspace A", async () => {
    const marker = `agent-registry-B-only ${Date.now()}-${Math.random()}`;
    const { definitionId, versionId } = await withTenant(pool, B, async (tx) => {
      const def = await tx.query(
        `insert into agent_definition (id, workspace_id, role, mission) values (gen_random_uuid(), $1, 'research', $2) returning id`,
        [B, marker],
      );
      const version = await tx.query(
        `insert into agent_version (id, workspace_id, agent_definition_id, version_number, prompt_version, model_version, budget_usd)
         values (gen_random_uuid(), $1, $2, 1, 'p1', 'm1', 1.5) returning id`,
        [B, def.rows[0].id],
      );
      return { definitionId: def.rows[0].id as string, versionId: version.rows[0].id as string };
    });
    createdDefinitionIds.push(definitionId);
    createdVersionIds.push(versionId);

    const defSeenFromA = await withTenant(pool, A, (tx) =>
      tx.query("select count(*)::int as n from agent_definition where mission = $1", [marker]));
    expect(defSeenFromA.rows[0].n).toBe(0);

    const defSeenFromB = await withTenant(pool, B, (tx) =>
      tx.query("select count(*)::int as n from agent_definition where mission = $1", [marker]));
    expect(defSeenFromB.rows[0].n).toBe(1);

    const versionSeenFromA = await withTenant(pool, A, (tx) =>
      tx.query("select count(*)::int as n from agent_version where id = $1", [versionId]));
    expect(versionSeenFromA.rows[0].n).toBe(0);

    const versionSeenFromB = await withTenant(pool, B, (tx) =>
      tx.query("select count(*)::int as n from agent_version where id = $1", [versionId]));
    expect(versionSeenFromB.rows[0].n).toBe(1);
  });

  it("an agent_definition insert tagged with workspace B is refused while scoped to workspace A", async () => {
    const marker = `agent-registry-cross-def ${Date.now()}-${Math.random()}`;
    await expect(
      withTenant(pool, A, (tx) =>
        tx.query(
          `insert into agent_definition (id, workspace_id, role, mission) values (gen_random_uuid(), $1, 'research', $2)`,
          [B, marker],
        )),
    ).rejects.toThrow(/permission denied|row-level security|violates/i);
  });

  it("an agent_version insert tagged with workspace B is refused while scoped to workspace A", async () => {
    const marker = `agent-registry-cross-version ${Date.now()}-${Math.random()}`;
    const definitionId = await withTenant(pool, A, (tx) =>
      tx.query(
        `insert into agent_definition (id, workspace_id, role, mission) values (gen_random_uuid(), $1, 'content', $2) returning id`,
        [A, marker],
      ).then((r) => r.rows[0].id as string));
    createdDefinitionIds.push(definitionId);

    await expect(
      withTenant(pool, A, (tx) =>
        tx.query(
          `insert into agent_version (id, workspace_id, agent_definition_id, version_number, prompt_version, model_version, budget_usd)
           values (gen_random_uuid(), $1, $2, 1, 'p1', 'm1', 1.0)`,
          [B, definitionId],
        )),
    ).rejects.toThrow(/permission denied|row-level security|violates|foreign key/i);
  });
});

describe("agent_version.agent_definition_id -> agent_definition composite FK", () => {
  it("refuses an agent_version in workspace B pointing at workspace A's agent_definition", async () => {
    const marker = `agent-registry-fk-A ${Date.now()}-${Math.random()}`;
    // Distinct role from the other workspace-A agent_definition rows this
    // file creates: agent_definition has UNIQUE (workspace_id, role), so two
    // tests inserting the same role into the same workspace within one run
    // would collide.
    const definitionAId = await withTenant(pool, A, (tx) =>
      tx.query(
        `insert into agent_definition (id, workspace_id, role, mission) values (gen_random_uuid(), $1, 'seo_aeo', $2) returning id`,
        [A, marker],
      ).then((r) => r.rows[0].id as string));
    createdDefinitionIds.push(definitionAId);

    await expect(
      withTenant(pool, B, (tx) =>
        tx.query(
          `insert into agent_version (id, workspace_id, agent_definition_id, version_number, prompt_version, model_version, budget_usd)
           values (gen_random_uuid(), $1, $2, 1, 'p1', 'm1', 1.0)`,
          [B, definitionAId],
        )),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("still allows an agent_version in workspace B pointing at workspace B's own agent_definition", async () => {
    const marker = `agent-registry-fk-B ${Date.now()}-${Math.random()}`;
    const definitionBId = await withTenant(pool, B, (tx) =>
      tx.query(
        `insert into agent_definition (id, workspace_id, role, mission) values (gen_random_uuid(), $1, 'content', $2) returning id`,
        [B, marker],
      ).then((r) => r.rows[0].id as string));
    createdDefinitionIds.push(definitionBId);

    const versionId = await withTenant(pool, B, (tx) =>
      tx.query(
        `insert into agent_version (id, workspace_id, agent_definition_id, version_number, prompt_version, model_version, budget_usd)
         values (gen_random_uuid(), $1, $2, 1, 'p1', 'm1', 1.0) returning id`,
        [B, definitionBId],
      ).then((r) => r.rows[0].id as string));
    createdVersionIds.push(versionId);
  });
});

describe("agent_version CHECK constraints", () => {
  let definitionId: string;

  beforeAll(async () => {
    const marker = `agent-registry-check ${Date.now()}-${Math.random()}`;
    definitionId = await withTenant(pool, A, (tx) =>
      tx.query(
        `insert into agent_definition (id, workspace_id, role, mission) values (gen_random_uuid(), $1, 'qa_brand_safety', $2) returning id`,
        [A, marker],
      ).then((r) => r.rows[0].id as string));
    createdDefinitionIds.push(definitionId);
  });

  it("rejects budget_usd of zero", async () => {
    await expect(
      withTenant(pool, A, (tx) =>
        tx.query(
          `insert into agent_version (id, workspace_id, agent_definition_id, version_number, prompt_version, model_version, budget_usd)
           values (gen_random_uuid(), $1, $2, 1, 'p1', 'm1', 0)`,
          [A, definitionId],
        )),
    ).rejects.toThrow(/violates|check constraint/i);
  });

  it("rejects budget_usd that is negative", async () => {
    await expect(
      withTenant(pool, A, (tx) =>
        tx.query(
          `insert into agent_version (id, workspace_id, agent_definition_id, version_number, prompt_version, model_version, budget_usd)
           values (gen_random_uuid(), $1, $2, 2, 'p1', 'm1', -5)`,
          [A, definitionId],
        )),
    ).rejects.toThrow(/violates|check constraint/i);
  });

  it("rejects version_number of zero", async () => {
    await expect(
      withTenant(pool, A, (tx) =>
        tx.query(
          `insert into agent_version (id, workspace_id, agent_definition_id, version_number, prompt_version, model_version, budget_usd)
           values (gen_random_uuid(), $1, $2, 0, 'p1', 'm1', 1.0)`,
          [A, definitionId],
        )),
    ).rejects.toThrow(/violates|check constraint/i);
  });

  it("rejects version_number that is negative", async () => {
    await expect(
      withTenant(pool, A, (tx) =>
        tx.query(
          `insert into agent_version (id, workspace_id, agent_definition_id, version_number, prompt_version, model_version, budget_usd)
           values (gen_random_uuid(), $1, $2, -1, 'p1', 'm1', 1.0)`,
          [A, definitionId],
        )),
    ).rejects.toThrow(/violates|check constraint/i);
  });
});
