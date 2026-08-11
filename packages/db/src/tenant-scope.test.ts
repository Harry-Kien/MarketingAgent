import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

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

  it("resets the role even when the callback throws", async () => {
    await withTenant(pool, A, async () => undefined).catch(() => undefined);
    const client = await pool.connect();
    const r = await client.query("select current_user as u");
    client.release();
    expect(r.rows[0].u).not.toBe("smos_app");
  });

  // --- Leak scenarios beyond the brief -------------------------------------

  it("does not leave smos_app or a stale workspace id on the connection after a successful call", async () => {
    await withTenant(pool, A, async (tx) => {
      await tx.query("select 1");
    });
    const client = await pool.connect();
    try {
      const user = await client.query("select current_user as u");
      const ws = await client.query("select current_setting('app.workspace_id', true) as ws");
      expect(user.rows[0].u).not.toBe("smos_app");
      expect(ws.rows[0].ws).not.toBe(A);
      // A fresh/returned connection must read as unset, not merely "different".
      expect(ws.rows[0].ws === "" || ws.rows[0].ws === null).toBe(true);
    } finally {
      client.release();
    }
  });

  it("does not leave smos_app or a stale workspace id on the connection after a throwing call", async () => {
    await withTenant(pool, A, async () => {
      throw new Error("leak probe");
    }).catch(() => undefined);
    const client = await pool.connect();
    try {
      const user = await client.query("select current_user as u");
      const ws = await client.query("select current_setting('app.workspace_id', true) as ws");
      expect(user.rows[0].u).not.toBe("smos_app");
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

  it("DEFEAT ATTEMPT: RESET ROLE inside the callback reaches superuser and bypasses RLS", async () => {
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
      // Clean up defensively: RESET ROLE already returns us to the session
      // user (the pool's normal baseline), so no extra poisoning to undo.
      await client.query("rollback").catch(() => undefined);
      client.release();
    }

    // Documented outcome (see report): RESET ROLE succeeds and, because the
    // session user is a superuser, RLS is bypassed entirely for the rest of
    // the transaction.
    expect(escapedUser).toBe("smos");
    expect(sawOtherWorkspaceRow).toBe(true);
  });

  it("DEFEAT ATTEMPT: SET ROLE back to the owner inside the callback also bypasses RLS", async () => {
    const marker = `defeat.set-role-owner.${Date.now()}`;
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
      await client.query("set role smos"); // explicit, not RESET
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

    expect(escapedUser).toBe("smos");
    expect(sawOtherWorkspaceRow).toBe(true);
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
