// Late-review IMPORTANT 4: a stale metric could be relabelled current.
//
// The reviewer ran, as smos_app:
//
//   update metric set freshness_at = now() where id = <a 30-day-old row>
//
// ...which succeeded and left `confidence: "high"` untouched, so a month-old
// number was presented as measured moments ago at high confidence. A
// future-dated `freshness_at` also inserted fine. ADR-005 says a metric that
// cannot state its freshness and attribution must not exist -- but the
// freshness guarantee was presentational only: `MetricValue`
// (apps/web/src/ui/MetricValue.tsx) flags anything older than 24h, and the
// UPDATE above simply moved the row out of that window.
//
// A metric row is one observation at one instant (the route inserts a fresh
// row per webhook rather than overwriting -- ADR-005 again), so it has no
// legitimate post-insert lifecycle at all. Every attempt below runs as
// smos_app against the real database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@smos/domain";
import { createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const adminPool = createDbPool(adminUrl);

const workspaceId = newId();
let campaignId: string;

async function insertMetric(freshnessAtSql: string, confidence = "high"): Promise<string> {
  const id = newId();
  await withTenant(pool, workspaceId, (tx) =>
    tx.query(
      `insert into metric (id, workspace_id, campaign_id, name, value, freshness_at,
                            attribution_model, attribution_window, confidence)
       values ($1, $2, $3, 'reach', 512, ${freshnessAtSql}, 'last_touch', '7d', $4)`,
      [id, workspaceId, campaignId, confidence],
    ),
  );
  return id;
}

beforeAll(async () => {
  await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [workspaceId, `metric-freshness-${workspaceId}`]);
  const goalId = newId();
  await adminPool.query(`insert into goal (id, workspace_id, statement) values ($1, $2, 'metric freshness probe')`, [
    goalId,
    workspaceId,
  ]);
  campaignId = newId();
  await adminPool.query(
    `insert into campaign (id, workspace_id, goal_id, name, state) values ($1, $2, $3, $4, 'WAITING_APPROVAL')`,
    [campaignId, workspaceId, goalId, `metric-freshness-campaign-${campaignId}`],
  );
});

afterAll(async () => {
  await adminPool.query(`delete from metric where workspace_id = $1`, [workspaceId]).catch(() => undefined);
  await pool.end();
  await adminPool.end();
});

describe("metric freshness is a fact, not a label (IMPORTANT 4)", () => {
  it("refuses the reviewer's relabel: a 30-day-old row cannot be stamped now()", async () => {
    // Recorded honestly at 'low' -- a 30-day-old observation can no longer be
    // WRITTEN at 'high' either (see the last test in this file), which is the
    // other half of the same finding.
    const id = await insertMetric(`now() - interval '30 days'`, "low");
    await expect(
      withTenant(pool, workspaceId, (tx) => tx.query(`update metric set freshness_at = now() where id = $1`, [id])),
    ).rejects.toThrow(/observation|immutable|permission denied/i);

    const after = await adminPool.query(
      `select extract(epoch from (now() - freshness_at))::int as age_seconds from metric where id = $1`,
      [id],
    );
    expect(after.rows[0].age_seconds).toBeGreaterThan(29 * 24 * 3600);
  });

  it("refuses moving confidence up on a recorded observation", async () => {
    const id = await insertMetric(`now() - interval '30 days'`, "low");
    await expect(
      withTenant(pool, workspaceId, (tx) => tx.query(`update metric set confidence = 'high' where id = $1`, [id])),
    ).rejects.toThrow(/observation|immutable|permission denied/i);
  });

  it("refuses rewriting the measured value itself", async () => {
    const id = await insertMetric(`now()`);
    await expect(
      withTenant(pool, workspaceId, (tx) => tx.query(`update metric set value = 999999 where id = $1`, [id])),
    ).rejects.toThrow(/observation|immutable|permission denied/i);
  });

  it("refuses a future-dated freshness_at at INSERT", async () => {
    await expect(insertMetric(`now() + interval '1 day'`)).rejects.toThrow(
      /is in the future; a metric cannot have been measured at a time that has not happened/,
    );
  });

  it("still accepts an honest observation stamped now()", async () => {
    const id = await insertMetric(`now()`);
    const r = await adminPool.query(`select count(*)::int as n from metric where id = $1`, [id]);
    expect(r.rows[0].n).toBe(1);
  });

  it("refuses a 'high' confidence claim on an observation that is already stale", async () => {
    // MetricValue's own rule (apps/web/src/ui/MetricValue.tsx) is that a
    // metric older than 24h is stale. A row that is born stale must not also
    // claim the top confidence tier -- the presentational warning and the
    // stored claim have to agree, or the badge contradicts the data.
    await expect(insertMetric(`now() - interval '30 days'`, "high")).rejects.toThrow(
      /is already stale \(over 24 hours old\) and cannot be recorded at confidence "high"/,
    );
  });
});
