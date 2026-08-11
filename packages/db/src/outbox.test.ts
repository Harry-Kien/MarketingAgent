// Task 11: transactional outbox. Every property here is proven against a
// real PostgreSQL (never mocked): RLS, FOR UPDATE SKIP LOCKED and
// transaction rollback are exactly the mechanisms this file has to trust.
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

// Admin connection: only used to seed/clean up outside any single
// workspace's RLS view (workspace rows themselves, and end-of-suite
// cleanup of outbox rows this file created). Never used to exercise the
// behavior under test -- every assertion about tenant scoping or draining
// goes through the smos_app pool above, exactly as the application would.
const adminUrl =
  process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);

const A = "99999999-9999-7999-8999-999999999999" as Id;
const B = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa" as Id;
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
    sql`insert into workspace (id, name) values (${A}::uuid, ${"outbox-A-" + suffix}), (${B}::uuid, ${"outbox-B-" + suffix}) on conflict do nothing`,
  );
});

afterAll(async () => {
  // Only this suite's own rows: correlation ids it minted, tracked as they
  // were created. Uses the admin connection because smos_app has no DELETE
  // on outbox (by design -- see 0016_outbox.sql).
  if (seenCorrelationIds.size > 0) {
    await adminPool.query("delete from outbox where correlation_id = any($1::uuid[])", [
      [...seenCorrelationIds],
    ]);
  }
  await pool.end();
  await adminPool.end();
});

describe("transactional outbox", () => {
  it("does not persist the event when the transaction rolls back", async () => {
    const correlationId = trackId(newId());
    await expect(
      withTenant(pool, A, async (tx) => {
        await enqueueInTransaction(tx, {
          workspaceId: A,
          eventType: `test.rollback.${suffix}`,
          payload: {},
          correlationId,
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await withTenant(pool, A, (tx) =>
      tx.query("select count(*)::int as n from outbox where correlation_id = $1", [correlationId]));
    expect(rows.rows[0].n).toBe(0);
  });

  it("persists the event when the transaction commits", async () => {
    const correlationId = trackId(newId());
    await withTenant(pool, A, (tx) =>
      enqueueInTransaction(tx, {
        workspaceId: A,
        eventType: `test.commit.${suffix}`,
        payload: { k: 1 },
        correlationId,
      }));
    const rows = await withTenant(pool, A, (tx) =>
      tx.query("select count(*)::int as n from outbox where correlation_id = $1", [correlationId]));
    expect(rows.rows[0].n).toBe(1);
  });

  it("drains pending events to the queue exactly once", async () => {
    const correlationId = trackId(newId());
    await withTenant(pool, A, (tx) =>
      enqueueInTransaction(tx, {
        workspaceId: A,
        eventType: `test.drain.${suffix}`,
        payload: { drained: true },
        correlationId,
      }));

    const q = fakeQueue();
    const first = await drainOutbox(pool, q as never);
    const second = await drainOutbox(pool, q as never);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);

    const sentForUs = q.sent.filter((s) => s.name === `test.drain.${suffix}`);
    expect(sentForUs).toHaveLength(1);

    const row = await withTenant(pool, A, (tx) =>
      tx.query("select published_at from outbox where correlation_id = $1", [correlationId]));
    expect(row.rows[0].published_at).not.toBeNull();
  });

  it("two concurrent drains never publish the same row twice (FOR UPDATE SKIP LOCKED)", async () => {
    const rowCount = 12;
    const correlationIds = Array.from({ length: rowCount }, () => trackId(newId()));
    await withTenant(pool, A, async (tx) => {
      for (const correlationId of correlationIds) {
        await enqueueInTransaction(tx, {
          workspaceId: A,
          eventType: `test.concurrent.${suffix}`,
          payload: {},
          correlationId,
        });
      }
    });

    const q1 = fakeQueue();
    const q2 = fakeQueue();
    // A second, independent pool: two truly separate connections draining
    // at the same time is what actually exercises SKIP LOCKED, rather than
    // two sequential calls against one pool that never overlap.
    const pool2 = createDbPool(url);
    try {
      const [n1, n2] = await Promise.all([
        drainOutbox(pool, q1 as never, rowCount),
        drainOutbox(pool2, q2 as never, rowCount),
      ]);

      const allSent = [...q1.sent, ...q2.sent].filter((s) => s.name === `test.concurrent.${suffix}`);
      // Every row was published exactly once, across both drains combined --
      // not zero (lost) and not twice (double-published) for any single row.
      expect(allSent).toHaveLength(rowCount);
      expect(n1 + n2).toBe(rowCount);

      const published = await withTenant(pool, A, (tx) =>
        tx.query(
          "select count(*)::int as n from outbox where correlation_id = any($1::uuid[]) and published_at is not null",
          [correlationIds],
        ));
      expect(published.rows[0].n).toBe(rowCount);
    } finally {
      await pool2.end();
    }
  });

  it("a drain that fails partway does not mark rows published that were never sent", async () => {
    const ok1 = trackId(newId());
    const failing = trackId(newId());
    const neverAttempted = trackId(newId());
    await withTenant(pool, A, async (tx) => {
      await enqueueInTransaction(tx, {
        workspaceId: A,
        eventType: `test.partial.${suffix}`,
        payload: { order: 1 },
        correlationId: ok1,
      });
      await enqueueInTransaction(tx, {
        workspaceId: A,
        eventType: `test.partial.fail.${suffix}`,
        payload: { order: 2 },
        correlationId: failing,
      });
      await enqueueInTransaction(tx, {
        workspaceId: A,
        eventType: `test.partial.${suffix}`,
        payload: { order: 3 },
        correlationId: neverAttempted,
      });
    });

    let calls = 0;
    const flakyQueue = {
      send: async (name: string) => {
        calls++;
        if (name === `test.partial.fail.${suffix}`) {
          throw new Error("queue unavailable");
        }
        return "id";
      },
    };

    await expect(drainOutbox(pool, flakyQueue as never, 3)).rejects.toThrow("queue unavailable");
    expect(calls).toBeGreaterThan(0);

    const rows = await withTenant(pool, A, (tx) =>
      tx.query(
        "select correlation_id, published_at from outbox where correlation_id = any($1::uuid[])",
        [[ok1, failing, neverAttempted]],
      ));
    const byId = new Map(rows.rows.map((r: { correlation_id: string; published_at: unknown }) => [
      r.correlation_id,
      r.published_at,
    ]));
    expect(byId.get(ok1)).not.toBeNull();
    expect(byId.get(failing)).toBeNull();
    expect(byId.get(neverAttempted)).toBeNull();

    // Clean up: the failed row is still pending and would otherwise be
    // drained by a later, unrelated test run against this same database.
    // Mark it done via a clean drain so it does not linger.
    const cleanupQueue = fakeQueue();
    await drainOutbox(pool, cleanupQueue as never, 10);
  });

  // --- Beyond the brief: tenant isolation on the outbox table itself ------

  it("a row belonging to workspace B is invisible when scoped to workspace A", async () => {
    const correlationId = trackId(newId());
    await withTenant(pool, B, (tx) =>
      enqueueInTransaction(tx, {
        workspaceId: B,
        eventType: `test.isolation.${suffix}`,
        payload: {},
        correlationId,
      }));

    const seenFromA = await withTenant(pool, A, (tx) =>
      tx.query("select count(*)::int as n from outbox where correlation_id = $1", [correlationId]));
    expect(seenFromA.rows[0].n).toBe(0);

    const seenFromB = await withTenant(pool, B, (tx) =>
      tx.query("select count(*)::int as n from outbox where correlation_id = $1", [correlationId]));
    expect(seenFromB.rows[0].n).toBe(1);
  });

  it("an insert tagged with workspace B is refused while scoped to workspace A", async () => {
    const correlationId = trackId(newId());
    await expect(
      withTenant(pool, A, (tx) =>
        enqueueInTransaction(tx, {
          workspaceId: B,
          eventType: `test.cross-tenant.${suffix}`,
          payload: {},
          correlationId,
        })),
    ).rejects.toThrow(/permission denied|row-level security|violates/i);
  });
});
