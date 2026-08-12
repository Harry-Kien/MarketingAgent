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
 *
 * `set local role smos_app` here is now defensive, not load-bearing: the
 * pool itself connects AS smos_app (DATABASE_URL, ADR-007), which has no
 * BYPASSRLS and is not a superuser, so RLS applies to every connection this
 * function ever gets from `pool.connect()` whether or not this line runs.
 * Previously the pool connected as the `smos` superuser and this line was
 * the only thing narrowing it -- callback code issuing `RESET ROLE` could
 * undo that and reach full superuser access (see task-5-report.md /
 * task-5b-report.md). It stays as a second, redundant layer: cheap
 * insurance if a future connection string is ever misconfigured back to a
 * privileged role.
 */
// The role every scope is opened as. withTenant only ever issues `set local
// role smos_app` (see below) -- this constant is what the boundary check
// below compares `current_user` back against, and it exists so both places
// stay in sync by construction rather than by convention.
const TENANT_ROLE = "smos_app";

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
    await client.query(`set local role ${TENANT_ROLE}`);
    await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await fn({ query: (text, values) => client.query(text, values as never) });

    // Boundary check (closes the hole documented in tenant-role.test.ts and
    // tenant-scope.test.ts's DEFEAT ATTEMPT tests): `tx.query` is a thin,
    // uninspected wrapper over the raw connection, so nothing stops callback
    // code from calling `set_config('app.workspace_id', ...)` or `set role`
    // itself and re-scoping the rest of its own body to a different tenant.
    // Read back what the session actually ends the callback holding and
    // compare it to what this call opened; if either drifted, refuse to let
    // anything the callback did reach COMMIT.
    //
    // Honest limits: this runs *after* `fn` has already returned, so it
    // cannot retroactively hide rows a hijacked callback already read while
    // re-scoped -- only reads are unaffected by a rollback. What it does
    // guarantee is that nothing a hijacked scope wrote can ever be
    // persisted, and that the caller gets a loud TenantViolationError
    // instead of a silently wrong result.
    const [wsCheck, userCheck] = await Promise.all([
      client.query("select current_setting('app.workspace_id', true) as ws"),
      client.query("select current_user as u"),
    ]);
    const endedWorkspaceId: string | null = wsCheck.rows[0].ws;
    const endedUser: string = userCheck.rows[0].u;
    if (endedWorkspaceId !== workspaceId || endedUser !== TENANT_ROLE) {
      throw new TenantViolationError(
        `Tenant scope hijacked inside withTenant: opened for workspace "${workspaceId}" as ` +
          `"${TENANT_ROLE}", but ended scoped to workspace "${String(endedWorkspaceId)}" as user ` +
          `"${endedUser}". The transaction was rolled back; nothing the callback did was committed.`,
      );
    }

    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
