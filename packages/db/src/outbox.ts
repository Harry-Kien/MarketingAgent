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
 * impossible even when application code is wrong. Instead, `pool` connects
 * as smos_app exactly as everywhere else, and the two privileged steps --
 * claiming a batch across workspaces, and marking a row published -- go
 * through `outbox_claim_batch` / `outbox_mark_published`, two narrow SQL
 * functions owned by a separate, NOLOGIN, BYPASSRLS-only role
 * (`smos_outbox_drainer`, see 0016_outbox.sql). smos_app is only ever
 * granted EXECUTE on those two functions, never BYPASSRLS itself and never
 * direct cross-workspace SELECT/UPDATE on `outbox`. The privilege escalation
 * is explicit, narrow and auditable in the migration, not incidental here.
 *
 * `outbox_claim_batch` uses `FOR UPDATE SKIP LOCKED`, which is what lets two
 * concurrent drains split a batch without either blocking on, or
 * double-publishing, the other's rows: the lock a claiming transaction
 * takes is held until that transaction commits or rolls back, and a second
 * drain's claim simply skips whatever the first has already locked.
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
      await client.query("select outbox_mark_published($1)", [row.id]);
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
