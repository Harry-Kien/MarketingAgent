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

  // 0003_pgboss_schema_owner.sql grants smos_app CREATE ON DATABASE smos so
  // pg-boss can bootstrap its own `pgboss` schema objects at boss.start().
  // That is a real privilege widening (task-5c) and must not silently creep
  // any further: it must not grant CREATE in `public` (where tenant tables
  // live), must not make smos_app a superuser or BYPASSRLS-capable, and must
  // not touch the append-only guard on audit_log. Pin all four here, next to
  // the other role assertions, so any future drift fails a test instead of
  // being discovered empirically again.
  it("has CREATE on the database (for pg-boss's own schema bootstrap) but not on schema public", async () => {
    const dbPriv = await db.execute(sql`select has_database_privilege('smos_app', 'smos', 'CREATE') as c`);
    expect((dbPriv.rows[0] as { c: boolean }).c).toBe(true);

    const schemaPriv = await db.execute(sql`select has_schema_privilege('smos_app', 'public', 'CREATE') as c`);
    expect((schemaPriv.rows[0] as { c: boolean }).c).toBe(false);
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
