import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createDbPool } from "./client.ts";

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
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

  it("cannot be defeated by an explicit where clause naming another workspace", async () => {
    const client = await pool.connect();
    try {
      // Seed a row for workspace B as the table owner (RLS is FORCEd so this
      // is the only way to guarantee a B row exists regardless of app-role
      // session state left over from other tests).
      await client.query(
        `insert into audit_log (id, workspace_id, event_type, actor_kind, payload)
         values (gen_random_uuid(), $1, 'test.b-explicit', 'system', '{}'::jsonb)`,
        [B],
      );

      await client.query("set role smos_app");
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
