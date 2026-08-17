import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { CONTENT_KINDS, VERIFICATION_STATUSES } from "@smos/domain";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);
const WS = "eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee";

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${WS}::uuid, 'content-check') on conflict do nothing`,
  );
});

afterAll(async () => {
  await pool.end();
});

async function seedCampaign(tx: { query: (t: string, v?: unknown[]) => Promise<{ rows: { id: string }[] }> }): Promise<string> {
  const goal = await tx.query(
    `insert into goal (id, workspace_id, statement) values (gen_random_uuid(), $1, 'content check probe') returning id`,
    [WS],
  );
  const campaign = await tx.query(
    `insert into campaign (id, workspace_id, goal_id, name, state) values (gen_random_uuid(), $1, $2, $3, 'DRAFT') returning id`,
    [WS, goal.rows[0].id, `content-check-campaign ${Date.now()}-${Math.random()}`],
  );
  return campaign.rows[0].id;
}

async function seedContentItem(): Promise<string> {
  return withTenant(pool, WS, async (tx) => {
    const campaignId = await seedCampaign(tx);
    const item = await tx.query(
      `insert into content_item (id, workspace_id, campaign_id, kind, title) values (gen_random_uuid(), $1, $2, 'social_post', $3) returning id`,
      [WS, campaignId, `content-check-item ${Date.now()}-${Math.random()}`],
    );
    return item.rows[0].id as string;
  });
}

async function seedContentVersion(): Promise<{ contentItemId: string; versionId: string }> {
  const contentItemId = await seedContentItem();
  const versionId = await withTenant(pool, WS, async (tx) => {
    const r = await tx.query(
      `insert into content_version (id, workspace_id, content_item_id, version_number, body)
       values (gen_random_uuid(), $1, $2, 1, 'seed body') returning id`,
      [WS, contentItemId],
    );
    return r.rows[0].id as string;
  });
  return { contentItemId, versionId };
}

describe("content_item.kind — CHECK constraint", () => {
  it("rejects an insert with an invalid kind", async () => {
    const campaignId = await withTenant(pool, WS, (tx) => seedCampaign(tx));
    await expect(
      withTenant(pool, WS, (tx) =>
        tx.query(
          `insert into content_item (id, workspace_id, campaign_id, kind, title) values (gen_random_uuid(), $1, $2, 'not_a_real_kind', $3)`,
          [WS, campaignId, `invalid-kind ${Date.now()}-${Math.random()}`],
        )),
    ).rejects.toThrow(/content_item_kind_check/);
  });

  it("accepts every valid ContentKind from the domain package", async () => {
    expect(CONTENT_KINDS.length).toBe(5);
    const campaignId = await withTenant(pool, WS, (tx) => seedCampaign(tx));
    for (const kind of CONTENT_KINDS) {
      await withTenant(pool, WS, (tx) =>
        tx.query(
          `insert into content_item (id, workspace_id, campaign_id, kind, title) values (gen_random_uuid(), $1, $2, $3, $4)`,
          [WS, campaignId, kind, `valid-kind-${kind} ${Date.now()}-${Math.random()}`],
        ));
    }
  });
});

describe("source_citation.verification_status — CHECK constraint", () => {
  it("rejects an insert with an invalid verification_status", async () => {
    const { versionId } = await seedContentVersion();
    await expect(
      withTenant(pool, WS, (tx) =>
        tx.query(
          `insert into source_citation (id, workspace_id, content_version_id, url, accessed_at, excerpt, verification_status)
           values (gen_random_uuid(), $1, $2, 'https://x.test', now(), 'e', 'NOT_A_REAL_STATUS')`,
          [WS, versionId],
        )),
    ).rejects.toThrow(/source_citation_verification_status_check/);
  });

  it("accepts every valid VerificationStatus from the domain package", async () => {
    expect(VERIFICATION_STATUSES.length).toBe(4);
    const { versionId } = await seedContentVersion();
    for (const status of VERIFICATION_STATUSES) {
      await withTenant(pool, WS, (tx) =>
        tx.query(
          `insert into source_citation (id, workspace_id, content_version_id, url, accessed_at, excerpt, verification_status)
           values (gen_random_uuid(), $1, $2, 'https://x.test', now(), $3, $4)`,
          [WS, versionId, `valid-status-${status} ${Date.now()}-${Math.random()}`, status],
        ));
    }
  });
});

describe("content_version.version_number — uniqueness enforced by the database", () => {
  it("rejects a second version with the same version_number for the same content item, even bypassing addVersion", async () => {
    const { contentItemId } = await seedContentVersion(); // seeds version_number 1
    await expect(
      withTenant(pool, WS, (tx) =>
        tx.query(
          `insert into content_version (id, workspace_id, content_item_id, version_number, body)
           values (gen_random_uuid(), $1, $2, 1, 'duplicate version_number')`,
          [WS, contentItemId],
        )),
    ).rejects.toThrow(/content_version_content_item_id_version_number_key/);
  });

  it("allows the same version_number for two different content items", async () => {
    const contentItemA = await seedContentItem();
    const contentItemB = await seedContentItem();
    await withTenant(pool, WS, (tx) =>
      tx.query(
        `insert into content_version (id, workspace_id, content_item_id, version_number, body) values (gen_random_uuid(), $1, $2, 1, 'body a')`,
        [WS, contentItemA],
      ));
    await withTenant(pool, WS, (tx) =>
      tx.query(
        `insert into content_version (id, workspace_id, content_item_id, version_number, body) values (gen_random_uuid(), $1, $2, 1, 'body b')`,
        [WS, contentItemB],
      ));
  });
});
