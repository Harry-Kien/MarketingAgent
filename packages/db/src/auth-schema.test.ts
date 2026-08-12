// infra/migrations/0029_auth_schema.sql: better-auth's schema, adapted to
// this project's tenancy invariants. This file proves the two things that
// are specific to this migration and not already covered by
// cross-tenant.test.ts's generic, catalog-driven suite (which already
// proves workspace_member's RLS is enabled+forced with USING+WITH CHECK,
// and that a cross-workspace read/write against it is refused as smos_app):
//
//   1. resolve_user_workspace(uuid) -- the narrow, reviewed bootstrap bridge
//      that answers "which workspace does this user_id belong to" without
//      requiring app.workspace_id to already be set (the very value being
//      looked up) -- returns the right answer, and only the right answer,
//      never another user's or another workspace's.
//   2. Direct, ad-hoc SQL against workspace_member (i.e. NOT through the
//      bridge function) still gets normal RLS treatment: the bridge's
//      SECURITY DEFINER bypass is scoped to that one function, not a general
//      hole in the table's protection.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId, type Id } from "@smos/domain";
import { createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const adminPool = createDbPool(adminUrl);

interface Member {
  workspaceId: Id;
  userId: Id;
}

let a: Member;
let b: Member;

beforeAll(async () => {
  async function seed(label: string): Promise<Member> {
    const workspaceId = newId();
    const userId = newId();
    await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [workspaceId, `auth-schema-${label}-${workspaceId}`]);
    await adminPool.query(`insert into user_account (id, email, name) values ($1, $2, $3)`, [
      userId,
      `auth-schema-${label}-${workspaceId}@test.local`,
      label,
    ]);
    await adminPool.query(`insert into workspace_member (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`, [
      newId(),
      workspaceId,
      userId,
    ]);
    return { workspaceId, userId };
  }
  a = await seed("a");
  b = await seed("b");
});

afterAll(async () => {
  for (const m of [a, b]) {
    await adminPool.query("delete from workspace_member where workspace_id = $1", [m.workspaceId]).catch(() => undefined);
  }
  await pool.end();
  await adminPool.end();
});

describe("resolve_user_workspace: the session -> workspace bootstrap bridge", () => {
  it("resolves a user to the workspace they belong to", async () => {
    const r = await pool.query("select resolve_user_workspace($1) as workspace_id", [a.userId]);
    expect(r.rows[0].workspace_id).toBe(a.workspaceId);
  });

  it("resolves a different user in a different workspace independently", async () => {
    const r = await pool.query("select resolve_user_workspace($1) as workspace_id", [b.userId]);
    expect(r.rows[0].workspace_id).toBe(b.workspaceId);
  });

  it("never returns the wrong workspace for a real user (cross-check both directions)", async () => {
    const rA = await pool.query("select resolve_user_workspace($1) as workspace_id", [a.userId]);
    const rB = await pool.query("select resolve_user_workspace($1) as workspace_id", [b.userId]);
    expect(rA.rows[0].workspace_id).not.toBe(b.workspaceId);
    expect(rB.rows[0].workspace_id).not.toBe(a.workspaceId);
  });

  it("returns null for a user_id with no membership row", async () => {
    const r = await pool.query("select resolve_user_workspace($1) as workspace_id", [newId()]);
    expect(r.rows[0].workspace_id).toBeNull();
  });

  it("is callable by smos_app directly (no withTenant / app.workspace_id needed)", async () => {
    // Deliberately NOT wrapped in withTenant: this is the whole point of the
    // function -- it must work before any workspace scope is known. A fresh
    // connection that has never touched app.workspace_id at all proves this
    // cleanly (same technique as cross-tenant.test.ts's "with app.workspace_id
    // unset entirely" test).
    const r = await pool.query("select resolve_user_workspace($1) as workspace_id", [a.userId]);
    expect(r.rows[0].workspace_id).toBe(a.workspaceId);
  });
});

describe("workspace_member: the SECURITY DEFINER bridge does not weaken direct access", () => {
  it("a direct, non-bridge SELECT scoped to workspace A still cannot see workspace B's membership row", async () => {
    await withTenant(pool, a.workspaceId, async (tx) => {
      const byId = await tx.query("select id from workspace_member where user_id = $1", [b.userId]);
      expect(byId.rowCount).toBe(0);
      const explicit = await tx.query("select count(*)::int as n from workspace_member where workspace_id = $1", [b.workspaceId]);
      expect(explicit.rows[0].n).toBe(0);
    });
  });

  it("workspace A's own membership row is visible from its own scope (RLS isn't hiding everything)", async () => {
    await withTenant(pool, a.workspaceId, async (tx) => {
      const own = await tx.query("select id from workspace_member where user_id = $1", [a.userId]);
      expect(own.rowCount).toBe(1);
    });
  });
});

describe("account/session/verification: global tables (0029), not RLS-scoped", () => {
  it("account has a password column and no separate plaintext-secret-shaped column", async () => {
    const cols = await adminPool.query(`select column_name from information_schema.columns where table_name = 'account'`);
    const names = cols.rows.map((c: { column_name: string }) => c.column_name as string);
    expect(names).toContain("password");
    // better-auth stores a hash in `password`, never a raw secret elsewhere
    // on this row (task brief: "password hashes and session tokens are
    // stored per better-auth's design").
    for (const forbidden of ["api_key", "secret_key", "plaintext_password"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("session has no workspace_id column (it authenticates a user, not a workspace)", async () => {
    const cols = await adminPool.query(`select column_name from information_schema.columns where table_name = 'session'`);
    const names = cols.rows.map((c: { column_name: string }) => c.column_name as string);
    expect(names).not.toContain("workspace_id");
  });
});
