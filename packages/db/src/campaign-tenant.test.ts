import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);
const A = "55555555-5555-7555-8555-555555555555";
const B = "66666666-6666-7666-8666-666666666666";

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${A}::uuid, 'campaign-tenant-A'), (${B}::uuid, 'campaign-tenant-B') on conflict do nothing`,
  );
});

afterAll(async () => {
  await pool.end();
});

describe("campaign table — row level security", () => {
  it("is enabled and forced on campaign and goal", async () => {
    const r = await db.execute(
      sql`select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('campaign', 'goal')`,
    );
    const rows = r.rows as { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it("a campaign belonging to workspace B is invisible when scoped to workspace A", async () => {
    // A unique marker per run: this runs against a real, persistent
    // PostgreSQL database with no per-test cleanup, so a fixed literal name
    // would accumulate extra matching rows across repeated test runs and
    // desync the exact-count assertions below.
    const marker = `B-only campaign ${Date.now()}`;
    const goalId = await withTenant(pool, B, async (tx) => {
      const goal = await tx.query(
        `insert into goal (id, workspace_id, statement) values (gen_random_uuid(), $1, 'grow leads') returning id`,
        [B],
      );
      await tx.query(
        `insert into campaign (id, workspace_id, goal_id, name, state)
         values (gen_random_uuid(), $1, $2, $3, 'DRAFT')`,
        [B, goal.rows[0].id, marker],
      );
      return goal.rows[0].id as string;
    });

    const seenFromA = await withTenant(pool, A, (tx) =>
      tx.query("select count(*)::int as n from campaign where name = $1", [marker]));
    expect(seenFromA.rows[0].n).toBe(0);

    // Sanity check: the row genuinely exists when scoped back to B.
    const seenFromB = await withTenant(pool, B, (tx) =>
      tx.query("select count(*)::int as n from campaign where name = $1", [marker]));
    expect(seenFromB.rows[0].n).toBe(1);
    expect(goalId).toBeTruthy();
  });

  it("an insert tagged with workspace B is refused while scoped to workspace A", async () => {
    const marker = `cross-tenant insert ${Date.now()}`;
    await expect(
      withTenant(pool, A, async (tx) => {
        const goal = await tx.query(
          `insert into goal (id, workspace_id, statement) values (gen_random_uuid(), $1, 'A goal for cross-tenant probe') returning id`,
          [A],
        );
        // Tags the campaign row with workspace B's id while the session is
        // scoped to A -- the policy's WITH CHECK must reject this outright.
        await tx.query(
          `insert into campaign (id, workspace_id, goal_id, name, state)
           values (gen_random_uuid(), $1, $2, $3, 'DRAFT')`,
          [B, goal.rows[0].id, marker],
        );
      }),
    ).rejects.toThrow(/permission denied|row-level security|violates/i);
  });
});
