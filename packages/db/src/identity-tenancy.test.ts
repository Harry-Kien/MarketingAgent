// Final whole-branch review, IMPORTANT 4 and IMPORTANT 5 -- the two findings
// about the IDENTITY tables (workspace, user_account, session, account,
// verification) that 0029_auth_schema.sql introduced and nothing since
// constrained.
//
// IMPORTANT 5, as reported: "identity has no tenancy. workspace and
// user_account both have relrowsecurity = false; smos_app read all 86
// workspaces and all 65 users. And resolve_user_workspace is SECURITY
// DEFINER, owned by a superuser, and granted to PUBLIC, so it maps any user
// to a workspace while bypassing workspace_member's own RLS."
//
// IMPORTANT 4, as reported: "0030 guards the front door only. smos_app holds
// SELECT/INSERT/UPDATE/DELETE on session, account and verification, none of
// which have RLS. Minting a session row for any user succeeded live, and the
// account.password grant is present. Forged-session and password-overwrite
// are one statement away."
//
// Every probe below runs as smos_app on the real database -- the exact role
// the application, the worker and every agent all run as -- never as the
// migration role, and never against a mock.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId, type Id } from "@smos/domain";
import { createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const adminPool = createDbPool(adminUrl);

interface Tenant {
  workspaceId: Id;
  userId: Id;
  sessionId: Id;
  accountId: Id;
}

let a: Tenant;
let b: Tenant;

async function seed(label: string): Promise<Tenant> {
  const workspaceId = newId();
  const userId = newId();
  const sessionId = newId();
  const accountId = newId();
  await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [
    workspaceId,
    `identity-tenancy-${label}-${workspaceId}`,
  ]);
  await adminPool.query(`insert into user_account (id, email, name) values ($1, $2, $3)`, [
    userId,
    `identity-tenancy-${label}-${workspaceId}@test.local`,
    label,
  ]);
  await adminPool.query(
    `insert into workspace_member (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [newId(), workspaceId, userId],
  );
  await adminPool.query(
    `insert into session (id, user_id, token, expires_at) values ($1, $2, $3, now() + interval '1 day')`,
    [sessionId, userId, `identity-tenancy-token-${sessionId}`],
  );
  await adminPool.query(
    `insert into account (id, user_id, account_id, provider_id, password) values ($1, $2, $3, 'credential', $4)`,
    [accountId, userId, userId, `hashed-not-a-real-password-${accountId}`],
  );
  return { workspaceId, userId, sessionId, accountId };
}

beforeAll(async () => {
  a = await seed("a");
  b = await seed("b");
});

afterAll(async () => {
  for (const t of [a, b].filter((x): x is Tenant => x !== undefined)) {
    await adminPool.query("delete from session where id = $1", [t.sessionId]).catch(() => undefined);
    await adminPool.query("delete from account where id = $1", [t.accountId]).catch(() => undefined);
    await adminPool.query("delete from workspace_member where workspace_id = $1", [t.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from user_account where id = $1", [t.userId]).catch(() => undefined);
    await adminPool.query("delete from workspace where id = $1", [t.workspaceId]).catch(() => undefined);
  }
  await pool.end();
  await adminPool.end();
});

describe("IMPORTANT 5: workspace is scoped to itself -- its own id IS its tenancy column", () => {
  it("has row level security enabled and forced", async () => {
    const r = await adminPool.query(
      `select relrowsecurity, relforcerowsecurity from pg_class where relname = 'workspace'`,
    );
    expect(r.rows[0].relrowsecurity).toBe(true);
    expect(r.rows[0].relforcerowsecurity).toBe(true);
  });

  it("smos_app scoped to workspace A can no longer read the whole workspace table", async () => {
    // The reported symptom exactly: "smos_app read all 86 workspaces".
    const total = await adminPool.query(`select count(*)::int as n from workspace`);
    expect(total.rows[0].n).toBeGreaterThan(1);

    const seen = await withTenant(pool, a.workspaceId, (tx) =>
      tx.query(`select count(*)::int as n from workspace`));
    expect(seen.rows[0].n).toBe(1);
  });

  it("smos_app scoped to workspace A sees A's own row and not B's, even naming B directly", async () => {
    await withTenant(pool, a.workspaceId, async (tx) => {
      const own = await tx.query(`select id from workspace where id = $1`, [a.workspaceId]);
      expect(own.rowCount).toBe(1);
      const other = await tx.query(`select id from workspace where id = $1`, [b.workspaceId]);
      expect(other.rowCount).toBe(0);
    });
  });

  it("smos_app can neither rename nor delete a workspace", async () => {
    const r = await adminPool.query(
      `select has_table_privilege('smos_app','workspace','UPDATE') as upd,
              has_table_privilege('smos_app','workspace','DELETE') as del`,
    );
    expect(r.rows[0].upd).toBe(false);
    expect(r.rows[0].del).toBe(false);
  });
});

describe("IMPORTANT 5: user_account tenancy is MEMBERSHIP-derived, never a workspace_id column", () => {
  it("has row level security enabled and forced", async () => {
    const r = await adminPool.query(
      `select relrowsecurity, relforcerowsecurity from pg_class where relname = 'user_account'`,
    );
    expect(r.rows[0].relrowsecurity).toBe(true);
    expect(r.rows[0].relforcerowsecurity).toBe(true);
  });

  it("still has NO workspace_id column: a user may belong to several workspaces", async () => {
    // The deliberate part of the decision. Stamping a workspace_id on
    // user_account would make the D1-7 multi-workspace case unrepresentable
    // -- the row would have to be duplicated per workspace, and
    // approval_decision's foreign key would then point at one of several
    // copies of the same human.
    const cols = await adminPool.query(
      `select column_name from information_schema.columns where table_name = 'user_account'`,
    );
    const names = cols.rows.map((c: { column_name: string }) => c.column_name as string);
    expect(names).not.toContain("workspace_id");
  });

  it("smos_app scoped to workspace A can no longer read every user in the system", async () => {
    const total = await adminPool.query(`select count(*)::int as n from user_account`);
    expect(total.rows[0].n).toBeGreaterThan(1);

    const seen = await withTenant(pool, a.workspaceId, (tx) =>
      tx.query(`select count(*)::int as n from user_account`));
    expect(seen.rows[0].n).toBeLessThan(total.rows[0].n);
  });

  it("smos_app scoped to workspace A sees A's own member and not B's, even naming B's user directly", async () => {
    await withTenant(pool, a.workspaceId, async (tx) => {
      const own = await tx.query(`select id from user_account where id = $1`, [a.userId]);
      expect(own.rowCount).toBe(1);
      const other = await tx.query(`select id from user_account where id = $1`, [b.userId]);
      expect(other.rowCount).toBe(0);
      // ...and not through a subquery either, so the policy is proved to
      // apply wherever the table is scanned, not only at the top level.
      const sub = await tx.query(
        `select count(*)::int as n from user_account where id in (select user_id from workspace_member)`,
      );
      expect(sub.rows[0].n).toBe(1);
    });
  });
});

describe("IMPORTANT 5: resolve_user_workspace is no longer callable by PUBLIC", () => {
  it("PUBLIC has no EXECUTE privilege on the SECURITY DEFINER bridge", async () => {
    // It is SECURITY DEFINER, owned by a superuser, and deliberately bypasses
    // workspace_member's own RLS -- so who may call it at all is the only
    // boundary it has. Granting it to PUBLIC handed that boundary to every
    // role in the cluster, present and future.
    const r = await adminPool.query(
      `select has_function_privilege('public', 'resolve_user_workspace(uuid)', 'EXECUTE') as pub,
              has_function_privilege('smos_app', 'resolve_user_workspace(uuid)', 'EXECUTE') as app`,
    );
    expect(r.rows[0].pub).toBe(false);
    // ...and the one role that legitimately needs it at sign-in still has it,
    // so this fails for the right reason if a future migration revokes
    // everything instead of just PUBLIC.
    expect(r.rows[0].app).toBe(true);
  });

  it("still resolves the right workspace for the role that is allowed to call it", async () => {
    const r = await pool.query("select resolve_user_workspace($1) as workspace_id", [a.userId]);
    expect(r.rows[0].workspace_id).toBe(a.workspaceId);
  });
});

describe("IMPORTANT 4: smos_app cannot touch the authentication tables at all", () => {
  it.each(["session", "account", "verification"])(
    "%s: smos_app holds no SELECT, INSERT, UPDATE or DELETE by ANY grant path",
    async (table) => {
      // has_table_privilege resolves EFFECTIVE privilege, so a grant made to
      // PUBLIC or inherited through role membership reads true here too --
      // the gap that made 0030's own pin defeatable (IMPORTANT 3).
      const r = await adminPool.query(
        `select has_table_privilege('smos_app', $1, 'SELECT') as sel,
                has_table_privilege('smos_app', $1, 'INSERT') as ins,
                has_table_privilege('smos_app', $1, 'UPDATE') as upd,
                has_table_privilege('smos_app', $1, 'DELETE') as del`,
        [table],
      );
      expect(r.rows[0].sel).toBe(false);
      expect(r.rows[0].ins).toBe(false);
      expect(r.rows[0].upd).toBe(false);
      expect(r.rows[0].del).toBe(false);
    },
  );

  it("minting a session for another user is refused -- the reported forged-session attack", async () => {
    // Reproduced by the reviewer live: one INSERT into session naming any
    // user_id, and the next request authenticates as that person. Combined
    // with CRITICAL 2 that was a complete authentication bypass from a SQL
    // connection.
    const forgedSessionId = newId();
    try {
      await expect(
        pool.query(
          `insert into session (id, user_id, token, expires_at) values ($1, $2, $3, now() + interval '1 day')`,
          [forgedSessionId, b.userId, `forged-${forgedSessionId}`],
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await adminPool.query("delete from session where id = $1", [forgedSessionId]).catch(() => undefined);
    }
  });

  it("overwriting a stored password hash is refused -- the reported password-overwrite attack", async () => {
    await expect(
      pool.query(`update account set password = $1 where id = $2`, ["overwritten-by-smos_app", b.accountId]),
    ).rejects.toThrow(/permission denied/i);

    const after = await adminPool.query(`select password from account where id = $1`, [b.accountId]);
    expect(after.rows[0].password).toBe(`hashed-not-a-real-password-${b.accountId}`);
  });

  it("reading a stored password hash is refused outright, not merely filtered to zero rows", async () => {
    await expect(pool.query(`select password from account where id = $1`, [b.accountId])).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("deleting somebody's session (a denial-of-service on their sign-in) is refused", async () => {
    await expect(pool.query(`delete from session where id = $1`, [b.sessionId])).rejects.toThrow(
      /permission denied/i,
    );
    const still = await adminPool.query(`select count(*)::int as n from session where id = $1`, [b.sessionId]);
    expect(still.rows[0].n).toBe(1);
  });
});

describe("IMPORTANT 4: smos_auth is the separate, narrow credential that owns the auth surface", () => {
  it("exists, and is neither a member of smos_app nor granted to it", async () => {
    const exists = await adminPool.query(`select 1 from pg_roles where rolname = 'smos_auth'`);
    expect(exists.rowCount).toBe(1);
    // Same disjoint-credentials shape as smos_vault (0036): a leaked
    // DATABASE_URL must not reach the auth tables by any SQL whatsoever, and
    // a leaked DATABASE_AUTH_URL must not reach anything else this
    // application owns.
    const membership = await adminPool.query(
      `select pg_has_role('smos_auth', 'smos_app', 'USAGE') as auth_is_app,
              pg_has_role('smos_app', 'smos_auth', 'USAGE') as app_is_auth`,
    );
    expect(membership.rows[0].auth_is_app).toBe(false);
    expect(membership.rows[0].app_is_auth).toBe(false);
  });

  it("can do exactly what signing in needs, and nothing this application owns", async () => {
    const r = await adminPool.query(
      `select has_table_privilege('smos_auth','session','INSERT') as session_ins,
              has_table_privilege('smos_auth','session','SELECT') as session_sel,
              has_table_privilege('smos_auth','account','SELECT')  as account_sel,
              has_table_privilege('smos_auth','account','UPDATE')  as account_upd,
              has_table_privilege('smos_auth','user_account','SELECT') as user_sel,
              has_table_privilege('smos_auth','user_account','INSERT') as user_ins,
              has_table_privilege('smos_auth','campaign','SELECT') as campaign_sel,
              has_table_privilege('smos_auth','approval_decision','INSERT') as decision_ins,
              has_table_privilege('smos_auth','vault_secret','SELECT') as vault_sel`,
    );
    expect(r.rows[0].session_ins).toBe(true);
    expect(r.rows[0].session_sel).toBe(true);
    expect(r.rows[0].account_sel).toBe(true);
    // Sign-up is unreachable through the running app and password changes are
    // not implemented, so the auth role may READ a credential to verify it
    // and never write one. Enabling either is a forward migration.
    expect(r.rows[0].account_upd).toBe(false);
    expect(r.rows[0].user_sel).toBe(true);
    expect(r.rows[0].user_ins).toBe(false);
    // ...and none of the application's own data, in either direction.
    expect(r.rows[0].campaign_sel).toBe(false);
    expect(r.rows[0].decision_ins).toBe(false);
    expect(r.rows[0].vault_sel).toBe(false);
  });
});
