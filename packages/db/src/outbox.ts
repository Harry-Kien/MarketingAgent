import type pg from "pg";
import { newId, type Id } from "@smos/domain";
import type { TenantTx } from "./tenant-scope.ts";

export interface OutboxEvent {
  workspaceId: Id;
  eventType: string;
  payload: Record<string, unknown>;
  correlationId: Id;
}

/**
 * Writing the event inside the caller's own transaction (via `tx` from
 * `withTenant`) is the whole point: the domain change and the intent to
 * publish it either both land or neither does (ADR-003). RLS's WITH CHECK
 * on `outbox` also means `event.workspaceId` must match the transaction's
 * own scope -- tagging a row for a different workspace is refused by
 * PostgreSQL itself, not by anything checked here.
 */
export async function enqueueInTransaction(tx: TenantTx, event: OutboxEvent): Promise<void> {
  await tx.query(
    `insert into outbox (id, workspace_id, event_type, payload, correlation_id)
     values ($1, $2, $3, $4::jsonb, $5)`,
    [newId(), event.workspaceId, event.eventType, JSON.stringify(event.payload), event.correlationId],
  );
}

/**
 * Structurally compatible with `@smos/queue`'s `Queue.send`, but declared
 * locally so this package does not need a dependency on `@smos/queue` just
 * to name a type -- `drainOutbox` only ever calls `send`.
 */
export interface MinimalQueue {
  send(name: string, data: unknown): Promise<string | null>;
}

interface OutboxRow {
  id: string;
  workspace_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  correlation_id: string;
  claimed_by: string;
}

/**
 * Drains pending outbox rows across every workspace in one pass -- that is
 * the point of a single background worker, and it is fundamentally at odds
 * with RLS's per-workspace USING clause (there is no single `app.workspace_id`
 * a cross-tenant drain could set).
 *
 * This does NOT run with an application role that has BYPASSRLS: that would
 * hand every other code path on this connection the same bypass, which is
 * exactly the class of incident ADR-007's database layer exists to make
 * impossible even when application code is wrong. `pool` here is expected to
 * connect as `smos_worker` (DATABASE_WORKER_URL) -- a separate login from
 * `smos_app` (DATABASE_URL) -- and the two privileged steps -- claiming a
 * batch across workspaces, and marking a row published -- go through
 * `outbox_claim_batch` / `outbox_mark_published`, two narrow SQL functions
 * owned by a separate, NOLOGIN, BYPASSRLS-only role (`smos_outbox_drainer`,
 * see 0016_outbox.sql / 0017_outbox_claim_token.sql). `smos_app` has no
 * EXECUTE on either function at all (fix round 1 -- it originally did, which
 * let any application code path read every tenant's pending payload via
 * `outbox_claim_batch`). The privilege escalation is explicit, narrow and
 * auditable in the migration, not incidental here.
 *
 * `outbox_claim_batch` uses `FOR UPDATE SKIP LOCKED`, which is what lets two
 * concurrent drains split a batch without either blocking on, or
 * double-publishing, the other's rows: the lock a claiming transaction
 * takes is held until that transaction commits or rolls back, and a second
 * drain's claim simply skips whatever the first has already locked. It also
 * stamps every row it claims with a single random `claimed_by` token for
 * that call. `outbox_mark_published` requires that exact token: a caller
 * that never claimed the row (fix round 1's other finding -- it originally
 * took no proof of claiming at all, so any `smos_app` session could mark
 * any row, including another tenant's, published without ever sending it)
 * updates nothing and gets `false` back, not an exception -- see
 * 0017_outbox_claim_token.sql for why that was the chosen behavior on
 * mismatch. Marking a row this same transaction just claimed must always
 * succeed; a `false` there can only mean something is badly wrong, so it is
 * raised as a hard error rather than silently ignored.
 *
 * A row is marked published only immediately after its event is actually
 * handed to `queue.send`, one row at a time, inside the same transaction
 * that claimed it. If `send` throws partway through a batch, the loop stops
 * there: rows already sent (and thus already marked published, in this same
 * still-open transaction) are committed as published, the row that failed
 * and every row after it are left exactly as claimed -- pending, and no
 * longer locked once this transaction ends -- and the original error is
 * re-thrown to the caller after that commit. A row's published_at can only
 * ever be non-null because it was truly sent.
 *
 * Crash recovery: if this process dies before the transaction commits,
 * PostgreSQL rolls the whole transaction back on connection loss, which
 * undoes the claim stamp along with everything else and releases the row's
 * lock -- a later drain's claim does not exclude previously-claimed rows,
 * so the row is picked up again automatically. Nothing is ever permanently
 * stranded and there is no separate release step.
 */
export async function drainOutbox(
  pool: pg.Pool,
  queue: MinimalQueue,
  batchSize = 100,
): Promise<number> {
  const client = await pool.connect();
  let published = 0;
  let failure: unknown;
  try {
    await client.query("begin");
    const claimed = await client.query(
      "select * from outbox_claim_batch($1)",
      [batchSize],
    );
    for (const row of claimed.rows as OutboxRow[]) {
      try {
        await queue.send(row.event_type, {
          workspaceId: row.workspace_id,
          payload: row.payload,
          correlationId: row.correlation_id,
        });
      } catch (error) {
        failure = error;
        break;
      }
      const marked = await client.query(
        "select outbox_mark_published($1, $2) as marked",
        [row.id, row.claimed_by],
      );
      if (marked.rows[0]?.marked !== true) {
        // This row was claimed by this same still-open transaction moments
        // ago; a mismatch here means the claim token contract itself is
        // broken, not a benign race -- fail loudly rather than silently
        // under-counting.
        throw new Error(
          `outbox: claim token mismatch marking row ${row.id} published -- this should be unreachable`,
        );
      }
      published++;
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (failure) throw failure;
  return published;
}
