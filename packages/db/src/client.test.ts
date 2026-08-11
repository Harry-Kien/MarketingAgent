import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createDbPool } from "./client.ts";

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);

afterAll(async () => {
  await pool.end();
});

describe("db client", () => {
  it("connects and runs a query", async () => {
    const result = await db.execute(sql`select 1 as one`);
    expect(result.rows[0]).toEqual({ one: 1 });
  });

  it("has the vector extension available", async () => {
    const result = await db.execute(sql`select extname from pg_extension where extname = 'vector'`);
    expect(result.rows).toHaveLength(1);
  });

  it("reports at least PostgreSQL 17", async () => {
    const result = await db.execute(sql`show server_version_num`);
    const row = result.rows[0] as { server_version_num: string };
    expect(Number(row.server_version_num)).toBeGreaterThanOrEqual(170000);
  });
});
