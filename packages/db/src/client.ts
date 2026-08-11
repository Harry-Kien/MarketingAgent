import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.ts";

/**
 * @types/pg must stay pinned to the exact version drizzle-orm depends on
 * (8.15.6). Any other version installs a second copy under this package, and
 * the two `Pool` types are then structurally incompatible, which fails the
 * build with a confusing "Pool is not assignable to Pool" error.
 */
export type Db = NodePgDatabase<typeof schema>;

export function createDbPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000 });
}

export function createDb(pool: pg.Pool): Db {
  // The schema module is still empty in P0, which stops TypeScript inferring
  // TSchema from the argument and makes it pick the wrong overload. Naming the
  // generic fixes that; the annotation can go once P1 adds real tables.
  return drizzle<typeof schema>(pool, { schema });
}
