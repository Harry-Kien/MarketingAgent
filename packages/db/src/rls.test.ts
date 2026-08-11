import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createDbPool } from "./client.ts";

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);
const A = "11111111-1111-7111-8111-111111111111";
const B = "22222222-2222-7222-8222-222222222222";

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${A}::uuid, 'A'), (${B}::uuid, 'B') on conflict do nothing`,
  );
});
afterAll(async () => {
  await pool.end();
});

describe("row level security", () => {
  it("is enabled on audit_log", async () => {
    const r = await db.execute(sql`select relrowsecurity from pg_class where relname = 'audit_log'`);
    expect((r.rows[0] as { relrowsecurity: boolean }).relrowsecurity).toBe(true);
  });

  it("is forced on audit_log (owner cannot bypass)", async () => {
    const r = await db.execute(sql`select relforcerowsecurity from pg_class where relname = 'audit_log'`);
    expect((r.rows[0] as { relforcerowsecurity: boolean }).relforcerowsecurity).toBe(true);
  });

  it("hides rows belonging to another workspace", async () => {
    const client = await pool.connect();
    try {
      await client.query("set role smos_app");
      await client.query("select set_config('app.workspace_id', $1, false)", [A]);
      await client.query(
        `insert into audit_log (id, workspace_id, event_type, actor_kind, payload)
         values (gen_random_uuid(), $1, 'test.a', 'system', '{}'::jsonb)`,
        [A],
      );
      await client.query("select set_config('app.workspace_id', $1, false)", [B]);
      const seen = await client.query("select count(*)::int as n from audit_log where event_type = 'test.a'");
      expect(seen.rows[0].n).toBe(0);
    } finally {
      await client.query("reset role").catch(() => undefined);
      client.release();
    }
  });

  it("refuses UPDATE and DELETE on audit_log (append-only)", async () => {
    const client = await pool.connect();
    try {
      await client.query("set role smos_app");
      await client.query("select set_config('app.workspace_id', $1, false)", [A]);
      await expect(client.query("update audit_log set event_type = 'tampered'")).rejects.toThrow(
        /append-only|permission denied/i,
      );
      await expect(client.query("delete from audit_log")).rejects.toThrow(/append-only|permission denied/i);
    } finally {
      await client.query("reset role").catch(() => undefined);
      client.release();
    }
  });

  it("gives the app role no BYPASSRLS", async () => {
    const r = await db.execute(sql`select rolbypassrls from pg_roles where rolname = 'smos_app'`);
    expect((r.rows[0] as { rolbypassrls: boolean }).rolbypassrls).toBe(false);
  });

  // Final whole-branch review, FINDING 2 (MEDIUM). 0003_pgboss_schema_owner.sql
  // originally granted smos_app CREATE ON DATABASE smos so pg-boss could
  // bootstrap its own `pgboss` schema objects at boss.start(). That grant let
  // smos_app create a real, un-migrated, RLS-less table ANYWHERE in the
  // database at runtime -- the reviewer demonstrated this concretely with a
  // `shadow.leaked_content` table readable across workspaces -- reducing
  // ADR-007's three layers of defense to one for anything created that way.
  //
  // Investigated and closed (0020_pgboss_revoke_database_create.sql): the
  // `pgboss` schema is pre-created and owned by smos_app before any
  // application code ever runs (0002/0003), which already gives smos_app
  // full, unconditional CREATE rights inside that one schema via ownership
  // alone -- CREATE ON DATABASE was never needed for the tables/indexes/
  // functions pg-boss's bootstrap actually creates. The one thing it WAS
  // needed for was pg-boss's own `CREATE SCHEMA IF NOT EXISTS pgboss`
  // clause, which packages/queue's createQueue (packages/queue/src/index.ts)
  // now disables via the `createSchema: false` constructor option -- schema
  // creation is the migrations' job here, not pg-boss's, so pg-boss never
  // needs to attempt it at all. Verified against a live database: `create
  // schema if not exists pgboss` as smos_app fails with "permission denied
  // for database smos" even though the schema already exists and smos_app
  // owns it -- PostgreSQL requires CREATE ON DATABASE for that statement
  // regardless of pre-existence -- confirming this was the exact (and only)
  // operation the grant was covering.
  //
  // smos_app now has CREATE on neither the database nor schema `public`.
  // Pin both here, next to the other role assertions, so any future drift
  // (a migration re-adding the grant, or packages/queue dropping
  // createSchema: false) fails a test instead of being discovered
  // empirically again.
  it("has CREATE on neither the database nor schema public", async () => {
    const dbPriv = await db.execute(sql`select has_database_privilege('smos_app', 'smos', 'CREATE') as c`);
    expect((dbPriv.rows[0] as { c: boolean }).c).toBe(false);

    const schemaPriv = await db.execute(sql`select has_schema_privilege('smos_app', 'public', 'CREATE') as c`);
    expect((schemaPriv.rows[0] as { c: boolean }).c).toBe(false);
  });

  it("still has CREATE inside pgboss via schema ownership alone, with no database-level grant", async () => {
    const owner = await db.execute(
      sql`select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'pgboss'`,
    );
    expect((owner.rows[0] as { owner: string }).owner).toBe("smos_app");

    const schemaPriv = await db.execute(sql`select has_schema_privilege('smos_app', 'pgboss', 'CREATE') as c`);
    expect((schemaPriv.rows[0] as { c: boolean }).c).toBe(true);

    const client = await pool.connect();
    try {
      await client.query("set role smos_app");
      await expect(client.query("create schema if not exists pgboss")).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await client.query("reset role").catch(() => undefined);
      client.release();
    }
  });

  it("is still not superuser and still has no BYPASSRLS", async () => {
    const r = await db.execute(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = 'smos_app'`,
    );
    const row = r.rows[0] as { rolsuper: boolean; rolbypassrls: boolean };
    expect(row.rolsuper).toBe(false);
    expect(row.rolbypassrls).toBe(false);
  });

  it("still cannot UPDATE or DELETE audit_log", async () => {
    const client = await pool.connect();
    try {
      await client.query("set role smos_app");
      await client.query("select set_config('app.workspace_id', $1, false)", [A]);
      await expect(client.query("update audit_log set event_type = 'tampered'")).rejects.toThrow(
        /append-only|permission denied/i,
      );
      await expect(client.query("delete from audit_log")).rejects.toThrow(/append-only|permission denied/i);
    } finally {
      await client.query("reset role").catch(() => undefined);
      client.release();
    }
  });

  it("cannot be defeated by an explicit where clause naming another workspace", async () => {
    const client = await pool.connect();
    try {
      await client.query("set role smos_app");
      // Seed a row for workspace B. ADR-007 (task-5b): the pool's
      // connecting role no longer bypasses RLS -- it used to be the `smos`
      // superuser here, for which FORCE ROW LEVEL SECURITY does not apply,
      // so this insert could run before any scope was set. smos_app has no
      // such bypass, so the row has to be inserted while actually scoped to
      // B, or RLS's WITH CHECK rejects it outright.
      await client.query("select set_config('app.workspace_id', $1, false)", [B]);
      await client.query(
        `insert into audit_log (id, workspace_id, event_type, actor_kind, payload)
         values (gen_random_uuid(), $1, 'test.b-explicit', 'system', '{}'::jsonb)`,
        [B],
      );

      await client.query("select set_config('app.workspace_id', $1, false)", [A]);
      // Even though the app role explicitly asks for workspace_id = B, RLS
      // must still filter it out because the session is scoped to A.
      const seen = await client.query(
        "select count(*)::int as n from audit_log where event_type = 'test.b-explicit' and workspace_id = $1",
        [B],
      );
      expect(seen.rows[0].n).toBe(0);
    } finally {
      await client.query("reset role").catch(() => undefined);
      client.release();
    }
  });
});
