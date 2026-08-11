import { sql } from "drizzle-orm";
import { parseServerEnv } from "@smos/contracts";
import { createDb, createDbPool } from "@smos/db";
import { checkHealth } from "../../../lib/health.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const env = parseServerEnv(process.env);
  const pool = createDbPool(env.DATABASE_URL);
  const db = createDb(pool);

  try {
    const report = await checkHealth({
      pingDb: async () => {
        await db.execute(sql`select 1`);
      },
      pingQueue: async () => {
        // pg-boss creates this table on start. Querying it proves the queue
        // schema is present in the same database the app is using.
        await db.execute(sql`select 1 from pgboss.version limit 1`);
      },
    });
    return Response.json(report, { status: report.status === "ok" ? 200 : 503 });
  } finally {
    await pool.end();
  }
}
