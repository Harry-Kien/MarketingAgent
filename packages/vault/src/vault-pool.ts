import pg from "pg";
import { isId, type Id } from "@smos/domain";
import { TenantViolationError } from "@smos/domain";

/**
 * Same shape as @smos/db's TenantTx, deliberately not imported from there:
 * packages/vault must never depend on packages/db's `withTenant`, which is
 * hardcoded to `smos_app` (packages/db/src/tenant-scope.ts). This package
 * needs the identical pattern under a DIFFERENT role, so it carries its own
 * copy rather than parameterising the shared one -- keeping "which role can
 * this scope possibly run as" a single, grep-able constant per package
 * instead of a runtime argument someone could pass wrong.
 */
export interface VaultTx {
  query(text: string, values?: unknown[]): Promise<pg.QueryResult>;
}

export function createVaultPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30_000 });
}

// The only role withVaultTenant ever narrows into. vault_secret grants
// SELECT/INSERT/UPDATE to smos_vault ONLY (0036_vault_secret.sql) --
// smos_app has no grant on this table at all, so this pool must never be
// pointed at DATABASE_URL, only at DATABASE_VAULT_URL.
const VAULT_ROLE = "smos_vault";

/**
 * packages/db's withTenant, copied rather than reused (see VaultTx's own
 * comment for why), narrowed to `smos_vault` instead of `smos_app`. Same
 * hijack boundary check: if callback code manages to re-scope the session
 * to a different workspace or a different role before this returns, nothing
 * it did is allowed to commit.
 */
export async function withVaultTenant<T>(
  pool: pg.Pool,
  workspaceId: Id,
  fn: (tx: VaultTx) => Promise<T>,
): Promise<T> {
  if (!isId(workspaceId)) {
    throw new TenantViolationError("A valid workspace id is required to open a vault tenant scope");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${VAULT_ROLE}`);
    await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await fn({ query: (text, values) => client.query(text, values as never) });

    const [wsCheck, userCheck] = await Promise.all([
      client.query("select current_setting('app.workspace_id', true) as ws"),
      client.query("select current_user as u"),
    ]);
    const endedWorkspaceId: string | null = wsCheck.rows[0].ws;
    const endedUser: string = userCheck.rows[0].u;
    if (endedWorkspaceId !== workspaceId || endedUser !== VAULT_ROLE) {
      throw new TenantViolationError(
        `Vault tenant scope hijacked inside withVaultTenant: opened for workspace "${workspaceId}" as ` +
          `"${VAULT_ROLE}", but ended scoped to workspace "${String(endedWorkspaceId)}" as user "${endedUser}". ` +
          `The transaction was rolled back; nothing the callback did was committed.`,
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
