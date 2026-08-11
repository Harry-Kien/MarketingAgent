import type pg from "pg";
import { isId, type Id } from "@smos/domain";
import { TenantViolationError } from "@smos/domain";

export interface TenantTx {
  query(text: string, values?: unknown[]): Promise<pg.QueryResult>;
}

/**
 * Every database access in the application goes through this. It opens a
 * transaction, drops to the non-BYPASSRLS role, and sets the session
 * variable the RLS policies read. Anything the callback does is therefore
 * confined to one workspace by PostgreSQL itself, not by our SQL (ADR-007).
 *
 * Both `set local role` and `set_config(..., true)` are transaction-local:
 * PostgreSQL unwinds them automatically on COMMIT or ROLLBACK, so a
 * connection handed back to the pool never carries `smos_app` or a stale
 * `app.workspace_id` into the next unrelated request.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  workspaceId: Id,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!isId(workspaceId)) {
    throw new TenantViolationError("A valid workspace id is required to open a tenant scope");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role smos_app");
    await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await fn({ query: (text, values) => client.query(text, values as never) });
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
