import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { MAIN_STATES, SIDE_STATES } from "@smos/domain";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);
const WS = "77777777-7777-7777-8777-777777777777";

const ALL_STATES = [...MAIN_STATES, ...SIDE_STATES];

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${WS}::uuid, 'campaign-state-check') on conflict do nothing`,
  );
});

afterAll(async () => {
  await pool.end();
});

async function insertGoal(): Promise<string> {
  return withTenant(pool, WS, async (tx) => {
    const r = await tx.query(
      `insert into goal (id, workspace_id, statement) values (gen_random_uuid(), $1, 'state check probe') returning id`,
      [WS],
    );
    return r.rows[0].id as string;
  });
}

describe("campaign.state — CHECK constraint", () => {
  it("rejects an insert with an invalid state", async () => {
    const goalId = await insertGoal();
    await expect(
      withTenant(pool, WS, (tx) =>
        tx.query(
          `insert into campaign (id, workspace_id, goal_id, name, state)
           values (gen_random_uuid(), $1, $2, $3, 'NOT_A_REAL_STATE')`,
          [WS, goalId, `invalid-insert ${Date.now()}`],
        )),
    ).rejects.toThrow(/campaign_state_valid/);
  });

  it("rejects updating an existing campaign's state to an invalid string", async () => {
    const goalId = await insertGoal();
    const marker = `invalid-update ${Date.now()}`;
    const campaignId = await withTenant(pool, WS, async (tx) => {
      const r = await tx.query(
        `insert into campaign (id, workspace_id, goal_id, name, state)
         values (gen_random_uuid(), $1, $2, $3, 'DRAFT') returning id`,
        [WS, goalId, marker],
      );
      return r.rows[0].id as string;
    });

    await expect(
      withTenant(pool, WS, (tx) =>
        tx.query(`update campaign set state = 'NOT_A_REAL_STATE' where id = $1`, [campaignId])),
    ).rejects.toThrow(/campaign_state_valid/);
  });

  it("accepts all fifteen valid lifecycle states", async () => {
    expect(ALL_STATES.length).toBe(15);
    const goalId = await insertGoal();
    for (const state of ALL_STATES) {
      const marker = `valid-${state} ${Date.now()}-${Math.random()}`;
      await withTenant(pool, WS, (tx) =>
        tx.query(
          `insert into campaign (id, workspace_id, goal_id, name, state)
           values (gen_random_uuid(), $1, $2, $3, $4)`,
          [WS, goalId, marker, state],
        ));
    }
  });
});
