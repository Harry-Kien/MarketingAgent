// ADR-007: "the application connects with a DB role that has no BYPASSRLS."
// Before this task, DATABASE_URL pointed at `smos`, a PostgreSQL superuser
// (docker-compose's POSTGRES_USER), and `withTenant` only ever *narrowed*
// that connection to `smos_app` with `SET LOCAL ROLE`. Callback code could
// undo the narrowing with `RESET ROLE` / `SET ROLE smos` and land back on
// the superuser, at which point RLS -- FORCE or not -- does not apply at
// all (see task-5-report.md). This file proves the fix: the application
// (and these tests, via DATABASE_URL) now connect AS `smos_app` directly,
// so there is no superuser identity left to fall back to.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url =
  process.env["DATABASE_URL"] ??
  "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);
// Reuses the same workspace fixture rows (and names) that rls.test.ts and
// tenant-scope.test.ts already seed. A brand-new (id, name) pair here hits
// an unrelated pre-existing local-dev anomaly: the `workspace` table on the
// shared dev database carries a stray, untracked `UNIQUE (name) DEFERRABLE
// INITIALLY DEFERRED` constraint that is not declared by any migration in
// infra/migrations/. PostgreSQL refuses a bare `ON CONFLICT DO NOTHING`
// insert outright whenever a deferrable unique constraint is a candidate
// arbiter and the new row's primary key does not already exist (error:
// "ON CONFLICT does not support deferrable unique constraints/exclusion
// constraints as arbiters") -- it only stays silent when the id itself
// already collides, which is exactly why the two pre-existing files' fixed
// ids/names keep working. That constraint is untracked local drift, not
// part of this task's schema, so this file works around it by reusing the
// already-inserted ids instead of touching it.
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

describe("smos_app connects directly (ADR-007)", () => {
  it("DATABASE_URL connects as smos_app, and smos_app is not a superuser", async () => {
    const client = await pool.connect();
    try {
      const user = await client.query("select current_user as u");
      expect(user.rows[0].u).toBe("smos_app");

      const role = await client.query(
        "select rolsuper from pg_roles where rolname = current_user",
      );
      expect(role.rows[0].rolsuper).toBe(false);
    } finally {
      client.release();
    }
  });

  it("RESET ROLE inside a withTenant callback no longer reaches a role that can see another workspace's rows", async () => {
    const marker = `role-fix.reset-role.${Date.now()}`;
    await withTenant(pool, A, (tx) =>
      tx.query(
        `insert into audit_log (id, workspace_id, event_type, actor_kind, payload)
         values (gen_random_uuid(), $1, $2, 'system', '{}'::jsonb)`,
        [A, marker],
      ));

    // Scoped to B. The callback tries the exact escape task-5-report.md
    // documented as successful: RESET ROLE, then read for A's marker.
    const seen = await withTenant(pool, B, async (tx) => {
      await tx.query("reset role");
      return tx.query("select count(*)::int as n from audit_log where event_type = $1", [
        marker,
      ]);
    });

    // Previously this returned 1 (RESET ROLE landed on the superuser
    // `smos`, and FORCE ROW LEVEL SECURITY does not apply to superusers).
    // Now the connection's own session/login role IS smos_app, so RESET
    // ROLE has nothing more privileged to return to -- RLS keeps applying
    // and the row stays invisible.
    expect(seen.rows[0].n).toBe(0);
  });

  it("SET ROLE smos inside a withTenant callback fails outright", async () => {
    // Previously this succeeded for the same reason RESET ROLE did (`smos`
    // was the session's login role, so switching back to it needs no
    // membership grant). Now the session's login role is smos_app itself,
    // and smos_app was never made a member of `smos`, so PostgreSQL
    // refuses the switch instead of silently granting it.
    await expect(
      withTenant(pool, A, async (tx) => {
        await tx.query("set role smos");
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("set_config to another workspace id mid-transaction still succeeds -- a different, still-open mechanism", async () => {
    const marker = `role-fix.set-config.${Date.now()}`;
    await withTenant(pool, B, (tx) =>
      tx.query(
        `insert into audit_log (id, workspace_id, event_type, actor_kind, payload)
         values (gen_random_uuid(), $1, $2, 'system', '{}'::jsonb)`,
        [B, marker],
      ));

    const sawOtherWorkspaceRow = await withTenant(pool, A, async (tx) => {
      // No role escalation attempted here -- still smos_app throughout.
      // The callback just overwrites the session variable RLS itself
      // reads.
      await tx.query("select set_config('app.workspace_id', $1, true)", [B]);
      const r = await tx.query("select count(*)::int as n from audit_log where event_type = $1", [
        marker,
      ]);
      return r.rows[0].n > 0;
    });

    // Reporting this plainly rather than hiding it (per task brief): this
    // still succeeds. RLS is still fully active and never bypassed -- the
    // policy is evaluated against `app.workspace_id` on every row, exactly
    // as designed -- but that session variable is itself just a value the
    // connected role (smos_app) is always allowed to set, so a callback
    // that deliberately overwrites it can still read outside the scope
    // `withTenant`'s caller asked for. This is NOT a superuser/BYPASSRLS
    // escape (layer 2 of ADR-007 never comes down), so it is a smaller and
    // different problem than what this task closes, but it is real and
    // undocumented elsewhere would be misleading to omit. See
    // task-5b-report.md for the recommended follow-up (likely: making
    // `withTenant`'s `TenantTx` not expose a raw `query` that can reach
    // `set_config` at all, which is a bigger, separate change).
    expect(sawOtherWorkspaceRow).toBe(true);
  });
});
