import { createDbPool } from "@smos/db";
import type pg from "pg";

// One pool per process, not one per request/page render. Next.js dev mode
// hot-reloads server modules on every file save; without caching the pool on
// `globalThis`, each reload would leak a fresh pg.Pool (and its connections)
// instead of reusing the one already open -- the same pattern commonly used
// for database clients in Next.js apps for exactly this reason.
const globalForPool = globalThis as unknown as { __smosDbPool?: pg.Pool };

export function getPool(): pg.Pool {
  if (!globalForPool.__smosDbPool) {
    const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
    globalForPool.__smosDbPool = createDbPool(url);
  }
  return globalForPool.__smosDbPool;
}
