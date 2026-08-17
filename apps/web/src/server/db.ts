import { createDbPool } from "@smos/db";
import type pg from "pg";

// One pool per process, not one per request/page render. Next.js dev mode
// hot-reloads server modules on every file save; without caching the pool on
// `globalThis`, each reload would leak a fresh pg.Pool (and its connections)
// instead of reusing the one already open -- the same pattern commonly used
// for database clients in Next.js apps for exactly this reason.
const globalForPool = globalThis as unknown as { __smosDbPool?: pg.Pool; __smosAuthPool?: pg.Pool };

export function getPool(): pg.Pool {
  if (!globalForPool.__smosDbPool) {
    const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
    globalForPool.__smosDbPool = createDbPool(url);
  }
  return globalForPool.__smosDbPool;
}

/**
 * The AUTHENTICATION pool -- a different credential from `getPool()`, on
 * purpose (infra/migrations/0038_identity_tenancy_and_auth_role.sql, final
 * whole-branch review IMPORTANT 4).
 *
 * smos_app used to hold SELECT/INSERT/UPDATE/DELETE on `session`, `account`
 * and `verification`, none of which have (or should have) RLS. Minting a
 * session row for any user was one INSERT away, and overwriting any stored
 * password hash was one UPDATE away -- from the same role every repository,
 * every worker handler and every agent already runs as. RLS cannot separate
 * those writes from the legitimate ones: the real INSERT happens
 * immediately after a password is verified in application code, and no
 * row-level predicate can tell the two apart. WHICH CREDENTIAL issued the
 * statement can, so that is the boundary -- exactly the shape
 * 0036_vault_secret.sql already uses for smos_vault.
 *
 * Only better-auth ever connects through this pool
 * (apps/web/src/server/auth-core.ts). smos_auth is not a member of smos_app
 * and smos_app is not a member of smos_auth: a leaked DATABASE_URL cannot
 * mint a session by any SQL whatsoever, and a leaked DATABASE_AUTH_URL
 * cannot read or write one row of this application's own data.
 */
export function getAuthPool(): pg.Pool {
  if (!globalForPool.__smosAuthPool) {
    const url =
      process.env["DATABASE_AUTH_URL"] ?? "postgres://smos_auth:smos_auth_local_dev@127.0.0.1:5433/smos";
    globalForPool.__smosAuthPool = createDbPool(url);
  }
  return globalForPool.__smosAuthPool;
}
