// Final whole-branch review, FINDING 5 (LOW). 0009_check_whitespace_hardening.sql
// converted every existing `CHECK (length(btrim(x)) > 0)` to `x ~ '\S'`
// (btrim() only strips ASCII spaces, not the full Unicode/regex whitespace
// class \s, so a value made only of tabs/newlines passed the old CHECK).
// But it only ever touched columns that ALREADY had a btrim CHECK -- four
// columns never had any blankness CHECK at all, in either form, and still
// accept a whitespace-only value today: goal.statement, source_citation.url,
// source_citation.excerpt, audit_log.event_type. This suite proves all four
// now reject a value with no non-whitespace character, the same `~ '\S'`
// rule 0009 applied everywhere else.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);
const WS = "f0f0f0f0-f0f0-7f0f-8f0f-f0f0f0f0f0f0";

const WHITESPACE_ONLY = "\t\n  "; // tabs/newlines/space -- btrim() alone would not catch this

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${WS}::uuid, 'whitespace-hardening-gap') on conflict do nothing`,
  );
});

afterAll(async () => {
  await pool.end();
});

async function seedContentVersionId(): Promise<string> {
  return withTenant(pool, WS, async (tx) => {
    const goal = await tx.query(
      `insert into goal (id, workspace_id, statement) values (gen_random_uuid(), $1, 'whitespace gap probe') returning id`,
      [WS],
    );
    const campaign = await tx.query(
      `insert into campaign (id, workspace_id, goal_id, name, state) values (gen_random_uuid(), $1, $2, $3, 'DRAFT') returning id`,
      [WS, goal.rows[0].id, `whitespace-gap-campaign ${Date.now()}-${Math.random()}`],
    );
    const item = await tx.query(
      `insert into content_item (id, workspace_id, campaign_id, kind, title) values (gen_random_uuid(), $1, $2, 'social_post', $3) returning id`,
      [WS, campaign.rows[0].id, `whitespace-gap-item ${Date.now()}-${Math.random()}`],
    );
    const version = await tx.query(
      `insert into content_version (id, workspace_id, content_item_id, version_number, body) values (gen_random_uuid(), $1, $2, 1, 'seed body') returning id`,
      [WS, item.rows[0].id],
    );
    return version.rows[0].id as string;
  });
}

describe("goal.statement — CHECK constraint (whitespace-only rejected)", () => {
  it("rejects a whitespace-only statement", async () => {
    await expect(
      withTenant(pool, WS, (tx) =>
        tx.query(`insert into goal (id, workspace_id, statement) values (gen_random_uuid(), $1, $2)`, [
          WS,
          WHITESPACE_ONLY,
        ])),
    ).rejects.toThrow(/goal_statement_check/);
  });

  it("accepts a real statement", async () => {
    await withTenant(pool, WS, (tx) =>
      tx.query(`insert into goal (id, workspace_id, statement) values (gen_random_uuid(), $1, $2)`, [
        WS,
        "a real goal statement",
      ]));
  });
});

describe("source_citation.url / excerpt — CHECK constraint (whitespace-only rejected)", () => {
  it("rejects a whitespace-only url", async () => {
    const versionId = await seedContentVersionId();
    await expect(
      withTenant(pool, WS, (tx) =>
        tx.query(
          `insert into source_citation (id, workspace_id, content_version_id, url, accessed_at, excerpt, verification_status)
           values (gen_random_uuid(), $1, $2, $3, now(), 'a real excerpt', 'VERIFIED')`,
          [WS, versionId, WHITESPACE_ONLY],
        )),
    ).rejects.toThrow(/source_citation_url_check/);
  });

  it("rejects a whitespace-only excerpt", async () => {
    const versionId = await seedContentVersionId();
    await expect(
      withTenant(pool, WS, (tx) =>
        tx.query(
          `insert into source_citation (id, workspace_id, content_version_id, url, accessed_at, excerpt, verification_status)
           values (gen_random_uuid(), $1, $2, 'https://x.test', now(), $3, 'VERIFIED')`,
          [WS, versionId, WHITESPACE_ONLY],
        )),
    ).rejects.toThrow(/source_citation_excerpt_check/);
  });

  it("accepts a real url and excerpt", async () => {
    const versionId = await seedContentVersionId();
    await withTenant(pool, WS, (tx) =>
      tx.query(
        `insert into source_citation (id, workspace_id, content_version_id, url, accessed_at, excerpt, verification_status)
         values (gen_random_uuid(), $1, $2, 'https://x.test', now(), 'a real excerpt', 'VERIFIED')`,
        [WS, versionId],
      ));
  });
});

describe("audit_log.event_type — CHECK constraint (whitespace-only rejected)", () => {
  it("rejects a whitespace-only event_type", async () => {
    await expect(
      withTenant(pool, WS, (tx) =>
        tx.query(
          `insert into audit_log (id, workspace_id, event_type, actor_kind) values (gen_random_uuid(), $1, $2, 'system')`,
          [WS, WHITESPACE_ONLY],
        )),
    ).rejects.toThrow(/audit_log_event_type_check/);
  });

  it("accepts a real event_type", async () => {
    await withTenant(pool, WS, (tx) =>
      tx.query(
        `insert into audit_log (id, workspace_id, event_type, actor_kind) values (gen_random_uuid(), $1, $2, 'system')`,
        [WS, "whitespace-gap.probe"],
      ));
  });
});
