import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);
const A = "cccccccc-cccc-7ccc-8ccc-cccccccccccc";
const B = "dddddddd-dddd-7ddd-8ddd-dddddddddddd";

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${A}::uuid, 'content-tenant-A'), (${B}::uuid, 'content-tenant-B') on conflict do nothing`,
  );
});

afterAll(async () => {
  await pool.end();
});

async function seedGoalAndCampaign(tx: { query: (t: string, v?: unknown[]) => Promise<{ rows: { id: string }[] }> }, ws: string) {
  const goal = await tx.query(
    `insert into goal (id, workspace_id, statement) values (gen_random_uuid(), $1, 'content tenant probe') returning id`,
    [ws],
  );
  const campaign = await tx.query(
    `insert into campaign (id, workspace_id, goal_id, name, state) values (gen_random_uuid(), $1, $2, $3, 'DRAFT') returning id`,
    [ws, goal.rows[0].id, `content-tenant-campaign ${Date.now()}-${Math.random()}`],
  );
  return campaign.rows[0].id;
}

describe("content_item, content_version, source_citation — row level security", () => {
  it("is enabled and forced on all three tables", async () => {
    const r = await db.execute(
      sql`select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('content_item', 'content_version', 'source_citation')`,
    );
    const rows = r.rows as { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it("rows belonging to workspace B are invisible when scoped to workspace A", async () => {
    // Unique markers per run: this database is persistent across test runs
    // with no per-test cleanup, so fixed literal names would accumulate
    // extra matching rows and desync the exact-count assertions below.
    const marker = `B-only content ${Date.now()}-${Math.random()}`;
    await withTenant(pool, B, async (tx) => {
      const campaignId = await seedGoalAndCampaign(tx, B);
      const item = await tx.query(
        `insert into content_item (id, workspace_id, campaign_id, kind, title) values (gen_random_uuid(), $1, $2, 'social_post', $3) returning id`,
        [B, campaignId, marker],
      );
      const version = await tx.query(
        `insert into content_version (id, workspace_id, content_item_id, version_number, body)
         values (gen_random_uuid(), $1, $2, 1, $3) returning id`,
        [B, item.rows[0].id, marker],
      );
      await tx.query(
        `insert into source_citation (id, workspace_id, content_version_id, url, accessed_at, excerpt, verification_status)
         values (gen_random_uuid(), $1, $2, 'https://b.test', now(), $3, 'VERIFIED')`,
        [B, version.rows[0].id, marker],
      );
    });

    const seenFromA = await withTenant(pool, A, async (tx) => {
      const items = await tx.query("select count(*)::int as n from content_item where title = $1", [marker]);
      const versions = await tx.query("select count(*)::int as n from content_version where body = $1", [marker]);
      const citations = await tx.query("select count(*)::int as n from source_citation where excerpt = $1", [marker]);
      return { items: items.rows[0].n, versions: versions.rows[0].n, citations: citations.rows[0].n };
    });
    expect(seenFromA).toEqual({ items: 0, versions: 0, citations: 0 });

    // Sanity check: the rows genuinely exist when scoped back to B.
    const seenFromB = await withTenant(pool, B, async (tx) => {
      const items = await tx.query("select count(*)::int as n from content_item where title = $1", [marker]);
      const versions = await tx.query("select count(*)::int as n from content_version where body = $1", [marker]);
      const citations = await tx.query("select count(*)::int as n from source_citation where excerpt = $1", [marker]);
      return { items: items.rows[0].n, versions: versions.rows[0].n, citations: citations.rows[0].n };
    });
    expect(seenFromB).toEqual({ items: 1, versions: 1, citations: 1 });
  });

  it("an insert tagged with workspace B is refused while scoped to workspace A (content_item)", async () => {
    const marker = `cross-tenant content_item ${Date.now()}-${Math.random()}`;
    await expect(
      withTenant(pool, A, async (tx) => {
        const campaignId = await seedGoalAndCampaign(tx, A);
        await tx.query(
          `insert into content_item (id, workspace_id, campaign_id, kind, title) values (gen_random_uuid(), $1, $2, 'social_post', $3)`,
          [B, campaignId, marker],
        );
      }),
    ).rejects.toThrow(/new row violates row-level security policy for table "content_item"/);
  });

  it("an insert tagged with workspace B is refused while scoped to workspace A (content_version)", async () => {
    const marker = `cross-tenant content_version ${Date.now()}-${Math.random()}`;
    await expect(
      withTenant(pool, A, async (tx) => {
        const campaignId = await seedGoalAndCampaign(tx, A);
        const item = await tx.query(
          `insert into content_item (id, workspace_id, campaign_id, kind, title) values (gen_random_uuid(), $1, $2, 'social_post', $3) returning id`,
          [A, campaignId, marker],
        );
        await tx.query(
          `insert into content_version (id, workspace_id, content_item_id, version_number, body)
           values (gen_random_uuid(), $1, $2, 1, $3)`,
          [B, item.rows[0].id, marker],
        );
      }),
    ).rejects.toThrow(/new row violates row-level security policy for table "content_version"/);
  });

  it("an insert tagged with workspace B is refused while scoped to workspace A (source_citation)", async () => {
    const marker = `cross-tenant source_citation ${Date.now()}-${Math.random()}`;
    await expect(
      withTenant(pool, A, async (tx) => {
        const campaignId = await seedGoalAndCampaign(tx, A);
        const item = await tx.query(
          `insert into content_item (id, workspace_id, campaign_id, kind, title) values (gen_random_uuid(), $1, $2, 'social_post', $3) returning id`,
          [A, campaignId, marker],
        );
        const version = await tx.query(
          `insert into content_version (id, workspace_id, content_item_id, version_number, body)
           values (gen_random_uuid(), $1, $2, 1, $3) returning id`,
          [A, item.rows[0].id, marker],
        );
        await tx.query(
          `insert into source_citation (id, workspace_id, content_version_id, url, accessed_at, excerpt, verification_status)
           values (gen_random_uuid(), $1, $2, 'https://a.test', now(), $3, 'VERIFIED')`,
          [B, version.rows[0].id, marker],
        );
      }),
    ).rejects.toThrow(/new row violates row-level security policy for table "source_citation"/);
  });
});
