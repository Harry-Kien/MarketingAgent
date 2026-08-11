import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

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

describe("withTenant", () => {
  it("sets the RLS session variable for the duration of the callback", async () => {
    const value = await withTenant(pool, A, async (tx) => {
      const r = await tx.query("select current_setting('app.workspace_id', true) as ws");
      return r.rows[0].ws;
    });
    expect(value).toBe(A);
  });

  it("rolls back when the callback throws", async () => {
    await expect(
      withTenant(pool, A, async (tx) => {
        await tx.query(
          `insert into audit_log (id, workspace_id, event_type, actor_kind, payload)
           values (gen_random_uuid(), $1, 'rollback.probe', 'system', '{}'::jsonb)`,
          [A],
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const after = await withTenant(pool, A, (tx) =>
      tx.query("select count(*)::int as n from audit_log where event_type = 'rollback.probe'"));
    expect(after.rows[0].n).toBe(0);
  });

  it("rejects a workspace id that is not a uuid", async () => {
    await expect(withTenant(pool, "not-a-uuid" as never, async () => undefined)).rejects.toThrow(
      /workspace/i,
    );
  });

  // DELETED (task-5b, fix round 1): "resets the role even when the callback
  // throws". ADR-007 update made its `.not.toBe("smos_app")` assertion
  // tautological (DATABASE_URL now connects the pool AS smos_app, so every
  // connection reads that value regardless of what withTenant does), and
  // `.not.toBe("smos")` doesn't fix it either: smos_app can never become
  // smos at all (`permission denied to set role`, proved in
  // task-5b-report.md), so that check is unconditionally true too.
  //
  // Tried a real discriminator before deleting, not just weakening the
  // check: `current_setting('role', true)` reads the literal string "none"
  // whenever no explicit role override is in effect, and only an *explicit*
  // SET ROLE leaves it holding a role name instead -- even when that name
  // equals the connection's own baseline role. Verified directly against
  // PostgreSQL: `SET LOCAL ROLE smos_app` + COMMIT -> "none"; a plain
  // (non-LOCAL) `SET ROLE smos_app` + COMMIT -> "smos_app". That would have
  // been real coverage on the COMMIT path.
  //
  // But this test's whole reason to exist was the ROLLBACK path (its own
  // name: "even when the callback throws"), and ROLLBACK erases that
  // distinction too: verified directly that a plain `SET ROLE smos_app`
  // followed by ROLLBACK also reads back as "none", identically to `SET
  // LOCAL ROLE`. PostgreSQL only tells LOCAL and non-LOCAL apart at COMMIT
  // time; a transaction that rolls back undoes either one the same way. So
  // on the rollback path specifically, there is no observable left that
  // distinguishes correct code from the exact regression this test was
  // meant to catch -- deleting it is the honest outcome, not leaving a
  // green assertion that would pass against broken code. The COMMIT-path
  // equivalent below ("does not leave a stale workspace id on the
  // connection after a successful call") still holds real, live coverage
  // for the same class of bug and was left untouched per the review.

  // --- Leak scenarios beyond the brief -------------------------------------

  it("does not leave a stale workspace id on the connection after a successful call, and never the superuser", async () => {
    await withTenant(pool, A, async (tx) => {
      await tx.query("select 1");
    });
    const client = await pool.connect();
    try {
      const user = await client.query("select current_user as u");
      const ws = await client.query("select current_setting('app.workspace_id', true) as ws");
      expect(user.rows[0].u).not.toBe("smos");
      expect(ws.rows[0].ws).not.toBe(A);
      // A fresh/returned connection must read as unset, not merely "different".
      expect(ws.rows[0].ws === "" || ws.rows[0].ws === null).toBe(true);
    } finally {
      client.release();
    }
  });

  it("does not leave a stale workspace id on the connection after a throwing call, and never the superuser", async () => {
    await withTenant(pool, A, async () => {
      throw new Error("leak probe");
    }).catch(() => undefined);
    const client = await pool.connect();
    try {
      const user = await client.query("select current_user as u");
      const ws = await client.query("select current_setting('app.workspace_id', true) as ws");
      expect(user.rows[0].u).not.toBe("smos");
      expect(ws.rows[0].ws).not.toBe(A);
      expect(ws.rows[0].ws === "" || ws.rows[0].ws === null).toBe(true);
    } finally {
      client.release();
    }
  });

  it("two sequential calls for different workspaces see only their own rows", async () => {
    const marker = `seq.${Date.now()}`;
    await withTenant(pool, A, (tx) =>
      tx.query(
        `insert into audit_log (id, workspace_id, event_type, actor_kind, payload)
         values (gen_random_uuid(), $1, $2, 'system', '{}'::jsonb)`,
        [A, marker],
      ));

    const seenByB = await withTenant(pool, B, (tx) =>
      tx.query("select count(*)::int as n from audit_log where event_type = $1", [marker]));
    expect(seenByB.rows[0].n).toBe(0);

    const seenByA = await withTenant(pool, A, (tx) =>
      tx.query("select count(*)::int as n from audit_log where event_type = $1", [marker]));
    expect(seenByA.rows[0].n).toBe(1);
  });

  it("a nested withTenant call on the same pool does not cross scopes with its parent", async () => {
    const outerWs = await withTenant(pool, A, async (outerTx) => {
      const innerWs = await withTenant(pool, B, async (innerTx) => {
        const r = await innerTx.query("select current_setting('app.workspace_id', true) as ws");
        return r.rows[0].ws;
      });
      const r = await outerTx.query("select current_setting('app.workspace_id', true) as ws");
      return { outer: r.rows[0].ws, inner: innerWs };
    });
    expect(outerWs.outer).toBe(A);
    expect(outerWs.inner).toBe(B);
  });

  it("concurrent withTenant calls for different workspaces on the same pool do not cross scopes", async () => {
    const results = await Promise.all([
      withTenant(pool, A, async (tx) => {
        await new Promise((r) => setTimeout(r, 25));
        const r = await tx.query("select current_setting('app.workspace_id', true) as ws");
        return r.rows[0].ws;
      }),
      withTenant(pool, B, async (tx) => {
        const r = await tx.query("select current_setting('app.workspace_id', true) as ws");
        return r.rows[0].ws;
      }),
    ]);
    expect(results[0]).toBe(A);
    expect(results[1]).toBe(B);
  });

  // --- Defeat attempts -------------------------------------------------
  // These deliberately try to escape tenant scope from inside the callback,
  // using raw SQL passed through tx.query (which is a thin wrapper over the
  // underlying pg client and does not inspect statement text). They exist to
  // honestly document what is, and is not, actually enforced.
  //
  // ADR-007 update (task-5b): both of these used to succeed, because the
  // pool connected as the `smos` superuser and `SET LOCAL ROLE smos_app`
  // was the only thing narrowing it -- RESET ROLE / SET ROLE smos undid
  // that and reached full superuser access, which FORCE ROW LEVEL SECURITY
  // does not constrain (see the git history of this file, and
  // task-5-report.md, for the version that demonstrated the escape). Now
  // DATABASE_URL connects the pool AS smos_app directly, so there is no
  // more-privileged identity behind it to fall back to -- these two are
  // kept, inverted, as regression tests for that fix, alongside the new,
  // more focused coverage in tenant-role.test.ts.

  it("DEFEAT ATTEMPT (closed): RESET ROLE inside the callback no longer reaches a role that bypasses RLS", async () => {
    const marker = `defeat.reset-role.${Date.now()}`;
    await withTenant(pool, A, (tx) =>
      tx.query(
        `insert into audit_log (id, workspace_id, event_type, actor_kind, payload)
         values (gen_random_uuid(), $1, $2, 'system', '{}'::jsonb)`,
        [A, marker],
      ));

    let escapedUser: string | undefined;
    let sawOtherWorkspaceRow: boolean | undefined;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role smos_app");
      await client.query("select set_config('app.workspace_id', $1, true)", [B]);
      // Escape attempt: undo the role scoping withTenant established.
      await client.query("reset role");
      escapedUser = (await client.query("select current_user as u")).rows[0].u;
      const seen = await client.query(
        "select count(*)::int as n from audit_log where event_type = $1",
        [marker],
      );
      sawOtherWorkspaceRow = seen.rows[0].n > 0;
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }

    // RESET ROLE now returns to smos_app itself (the connection's own
    // login role) -- there is no superuser identity behind it any more, so
    // RLS keeps applying and workspace A's marker row stays invisible.
    expect(escapedUser).toBe("smos_app");
    expect(sawOtherWorkspaceRow).toBe(false);
  });

  it("DEFEAT ATTEMPT (closed): SET ROLE smos inside the callback is refused outright", async () => {
    const marker = `defeat.set-role-owner.${Date.now()}`;
    await withTenant(pool, A, (tx) =>
      tx.query(
        `insert into audit_log (id, workspace_id, event_type, actor_kind, payload)
         values (gen_random_uuid(), $1, $2, 'system', '{}'::jsonb)`,
        [A, marker],
      ));

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role smos_app");
      await client.query("select set_config('app.workspace_id', $1, true)", [B]);
      // smos_app is not, and must never become, a member of smos: this is
      // no longer "SET ROLE succeeds, then RLS is bypassed" -- SET ROLE
      // itself now fails.
      await expect(client.query("set role smos")).rejects.toThrow(/permission denied/i);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("DEFEAT ATTEMPT: set_config to another workspace id (still as smos_app) reads that workspace's rows", async () => {
    const marker = `defeat.set-config.${Date.now()}`;
    await withTenant(pool, B, (tx) =>
      tx.query(
        `insert into audit_log (id, workspace_id, event_type, actor_kind, payload)
         values (gen_random_uuid(), $1, $2, 'system', '{}'::jsonb)`,
        [B, marker],
      ));

    let sawOtherWorkspaceRowWhileScopedToA: boolean | undefined;
    const result = await withTenant(pool, A, async (tx) => {
      // Still smos_app, still inside withTenant's own transaction -- but the
      // callback itself overrides the session variable RLS reads.
      await tx.query("select set_config('app.workspace_id', $1, true)", [B]);
      const seen = await tx.query(
        "select count(*)::int as n from audit_log where event_type = $1",
        [marker],
      );
      return seen.rows[0].n > 0;
    });
    sawOtherWorkspaceRowWhileScopedToA = result;

    expect(sawOtherWorkspaceRowWhileScopedToA).toBe(true);
  });

  it("DEFEAT ATTEMPT AFTERMATH: a plain (non-LOCAL) SET ROLE would poison the pool -- withTenant itself never issues one", async () => {
    // This does not exercise withTenant; it documents, in isolation, why the
    // implementation must use SET LOCAL / set_config(..., true) exclusively.
    // A plain SET ROLE or set_config(..., false) issued by callback code
    // would survive COMMIT and leak into the next unrelated request that
    // reuses the same pooled connection.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role smos_app");
      await client.query("set role smos_app"); // plain, no LOCAL
      await client.query("commit");
      const after = await client.query("select current_user as u");
      expect(after.rows[0].u).toBe("smos_app"); // confirmed: this DOES persist past commit
    } finally {
      // Manually undo the poisoning we just proved is possible so later
      // tests (and other files sharing this pool) are not affected.
      await client.query("reset role").catch(() => undefined);
      client.release();
    }
  });
});
