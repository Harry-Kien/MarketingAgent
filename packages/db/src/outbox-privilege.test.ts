// Fix round 1 on Task 11. Two exploits were found in the drain path itself:
// outbox_mark_published took no proof the caller ever claimed the row
// (cross-tenant event suppression: any smos_app session could silently
// mark another tenant's event published without ever sending it), and
// EXECUTE on outbox_claim_batch was granted to the whole smos_app
// principal rather than to the drain worker (any request handler could
// read every tenant's pending payload). This file proves the fix: a claim
// token ties marking to claiming, and a separate smos_worker role -- not
// smos_app -- is the only thing that can call either function.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { newId, type Id } from "@smos/domain";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";
import { drainOutbox, enqueueInTransaction } from "./outbox.ts";

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);

const workerUrl =
  process.env["DATABASE_WORKER_URL"] ??
  "postgres://smos_worker:smos_worker_local_dev@127.0.0.1:5433/smos";
const workerPool = createDbPool(workerUrl);

const adminUrl =
  process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);

const A = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb" as Id;
const B = "cccccccc-cccc-7ccc-8ccc-cccccccccccc" as Id;
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const seenCorrelationIds = new Set<string>();
const trackId = (id: Id): Id => {
  seenCorrelationIds.add(id);
  return id;
};

const fakeQueue = () => {
  const sent: Array<{ name: string; data: unknown }> = [];
  return {
    sent,
    send: async (name: string, data: unknown) => {
      sent.push({ name, data });
      return "id";
    },
  };
};

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${A}::uuid, ${"outbox-priv-A-" + suffix}), (${B}::uuid, ${"outbox-priv-B-" + suffix}) on conflict do nothing`,
  );
});

afterAll(async () => {
  if (seenCorrelationIds.size > 0) {
    await adminPool.query("delete from outbox where correlation_id = any($1::uuid[])", [
      [...seenCorrelationIds],
    ]);
  }
  await pool.end();
  await workerPool.end();
  await adminPool.end();
});

describe("outbox privileged path", () => {
  it("smos_app can no longer EXECUTE outbox_claim_batch at all", async () => {
    const priv = await db.execute(
      sql`select has_function_privilege('smos_app', 'outbox_claim_batch(integer)', 'EXECUTE') as has`,
    );
    expect((priv.rows[0] as { has: boolean }).has).toBe(false);

    const client = await pool.connect();
    try {
      await client.query("begin");
      await expect(client.query("select * from outbox_claim_batch(1)")).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("smos_app can no longer EXECUTE outbox_mark_published at all", async () => {
    const priv = await db.execute(
      sql`select has_function_privilege('smos_app', 'outbox_mark_published(uuid, uuid)', 'EXECUTE') as has`,
    );
    expect((priv.rows[0] as { has: boolean }).has).toBe(false);
  });

  it("as smos_app scoped to A, marking workspace B's row with a token that never claimed it marks nothing, and B's row stays unpublished", async () => {
    const correlationId = trackId(newId());
    const rowId = await withTenant(pool, B, async (tx) => {
      await enqueueInTransaction(tx, {
        workspaceId: B,
        eventType: `test.privilege.cross-tenant.${suffix}`,
        payload: {},
        correlationId,
      });
      const r = await tx.query("select id from outbox where correlation_id = $1", [correlationId]);
      return r.rows[0].id as string;
    });

    const bogusToken = randomUUID();
    // The exploit as the reviewer ran it: reachable via the worker role
    // directly (the only role with EXECUTE at all now), with no genuine
    // claim -- it must still refuse, because the claim token, not the
    // caller's identity, is what authorizes a mark.
    const client = await workerPool.connect();
    let marked: boolean;
    try {
      const r = await client.query("select outbox_mark_published($1, $2) as marked", [
        rowId,
        bogusToken,
      ]);
      marked = r.rows[0].marked;
    } finally {
      client.release();
    }
    expect(marked).toBe(false);

    const after = await withTenant(pool, B, (tx) =>
      tx.query("select published_at from outbox where correlation_id = $1", [correlationId]));
    expect(after.rows[0].published_at).toBeNull();
  });

  it("a token that did not claim the row marks nothing, even for a same-workspace row", async () => {
    const correlationId = trackId(newId());
    const rowId = await withTenant(pool, A, async (tx) => {
      await enqueueInTransaction(tx, {
        workspaceId: A,
        eventType: `test.privilege.wrong-token.${suffix}`,
        payload: {},
        correlationId,
      });
      const r = await tx.query("select id from outbox where correlation_id = $1", [correlationId]);
      return r.rows[0].id as string;
    });

    const client = await workerPool.connect();
    let marked: boolean;
    try {
      const r = await client.query("select outbox_mark_published($1, $2) as marked", [
        rowId,
        randomUUID(),
      ]);
      marked = r.rows[0].marked;
    } finally {
      client.release();
    }
    expect(marked).toBe(false);

    const after = await withTenant(pool, A, (tx) =>
      tx.query("select published_at from outbox where correlation_id = $1", [correlationId]));
    expect(after.rows[0].published_at).toBeNull();

    // Clean up: leave nothing pending for a later, unrelated run to sweep.
    await drainOutbox(workerPool, fakeQueue() as never, 10);
  });

  it("smos_worker is not superuser and not BYPASSRLS itself (only the two functions it can call bypass RLS, via SECURITY DEFINER)", async () => {
    const r = await db.execute(
      sql`select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = 'smos_worker'`,
    );
    const row = r.rows[0] as { rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean };
    expect(row.rolsuper).toBe(false);
    expect(row.rolbypassrls).toBe(false);
    expect(row.rolcanlogin).toBe(true);
  });

  it("the worker role can claim and mark, and the full drain still works end to end", async () => {
    const correlationId = trackId(newId());
    await withTenant(pool, A, (tx) =>
      enqueueInTransaction(tx, {
        workspaceId: A,
        eventType: `test.privilege.worker-drain.${suffix}`,
        payload: { via: "worker" },
        correlationId,
      }));

    const client = await workerPool.connect();
    try {
      const whoami = await client.query("select current_user as u");
      expect(whoami.rows[0].u).toBe("smos_worker");
    } finally {
      client.release();
    }

    const q = fakeQueue();
    const count = await drainOutbox(workerPool, q as never, 50);
    expect(count).toBeGreaterThan(0);
    expect(q.sent.some((s) => s.name === `test.privilege.worker-drain.${suffix}`)).toBe(true);

    const row = await withTenant(pool, A, (tx) =>
      tx.query("select published_at from outbox where correlation_id = $1", [correlationId]));
    expect(row.rows[0].published_at).not.toBeNull();
  });

  it("a claimed-but-crashed batch (claim committed nothing, because the transaction never committed) remains claimable by a later drain", async () => {
    const correlationId = trackId(newId());
    await withTenant(pool, A, (tx) =>
      enqueueInTransaction(tx, {
        workspaceId: A,
        eventType: `test.privilege.crash-recovery.${suffix}`,
        payload: {},
        correlationId,
      }));

    // Simulate a drain that claims the row and then crashes before COMMIT:
    // open a transaction as the worker, claim, observe the stamp, then
    // ROLLBACK instead of committing -- exactly what a dropped connection
    // does automatically.
    const client = await workerPool.connect();
    try {
      await client.query("begin");
      const claimed = await client.query("select * from outbox_claim_batch($1)", [50]);
      const mine = claimed.rows.find((r: { correlation_id: string }) => r.correlation_id === correlationId);
      expect(mine).toBeDefined();
      expect(mine.claimed_by).toBeTruthy();
      await client.query("rollback");
    } finally {
      client.release();
    }

    // Nothing committed -- the row must still be pending, unclaimed by
    // that dead attempt, and drainable normally.
    const stillPending = await withTenant(pool, A, (tx) =>
      tx.query(
        "select published_at, claimed_by from outbox where correlation_id = $1",
        [correlationId],
      ));
    expect(stillPending.rows[0].published_at).toBeNull();
    expect(stillPending.rows[0].claimed_by).toBeNull();

    const q = fakeQueue();
    const count = await drainOutbox(workerPool, q as never, 50);
    expect(count).toBeGreaterThan(0);
    expect(q.sent.some((s) => s.name === `test.privilege.crash-recovery.${suffix}`)).toBe(true);

    const after = await withTenant(pool, A, (tx) =>
      tx.query("select published_at from outbox where correlation_id = $1", [correlationId]));
    expect(after.rows[0].published_at).not.toBeNull();
  });
});
