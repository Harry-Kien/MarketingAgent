// Task 9: E3, the other half. Task 8 made it impossible for an agent to
// record an approval decision; this proves the database refuses to let a
// publication exist without one, without real (non-blank) publication_content,
// and without a unique idempotency_key -- even when called directly by
// smos_app, bypassing buildPublication entirely.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);

const adminUrl =
  process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);

const A = "22222222-2222-7222-8222-222222222222";
const B = "44444444-4444-7444-8444-444444444444";

async function seedUser(label: string): Promise<string> {
  const r = await adminPool.query(
    `insert into user_account (id,email,name) values (gen_random_uuid(),$1,$2) returning id`,
    [`${label}-${Date.now()}-${Math.random()}@test.local`, label],
  );
  return r.rows[0].id as string;
}

interface Chain {
  campaignId: string;
  versionId: string;
  decisionId: string;
}

async function seedChain(ws: string, userId: string): Promise<Chain> {
  return withTenant(pool, ws, async (tx) => {
    const goal = await tx.query(
      `insert into goal (id, workspace_id, statement) values (gen_random_uuid(), $1, 'publication invariants probe') returning id`,
      [ws],
    );
    const campaign = await tx.query(
      `insert into campaign (id, workspace_id, goal_id, name, state) values (gen_random_uuid(), $1, $2, $3, 'WAITING_APPROVAL') returning id`,
      [ws, goal.rows[0].id, `pub-invariants-campaign ${Date.now()}-${Math.random()}`],
    );
    const item = await tx.query(
      `insert into content_item (id, workspace_id, campaign_id, kind, title) values (gen_random_uuid(), $1, $2, 'social_post', $3) returning id`,
      [ws, campaign.rows[0].id, `pub-invariants-item ${Date.now()}-${Math.random()}`],
    );
    const version = await tx.query(
      `insert into content_version (id, workspace_id, content_item_id, version_number, body, publication_content)
       values (gen_random_uuid(), $1, $2, 1, 'body', 'the real published text') returning id`,
      [ws, item.rows[0].id],
    );
    const request = await tx.query(
      `insert into approval_request (id, workspace_id, campaign_id, content_version_id, target_channel)
       values (gen_random_uuid(), $1, $2, $3, 'meta_page') returning id`,
      [ws, campaign.rows[0].id, version.rows[0].id],
    );
    const decision = await tx.query(
      `insert into approval_decision (id, workspace_id, approval_request_id, actor_user_id, decision, reason)
       values (gen_random_uuid(), $1, $2, $3, 'approve', 'looks good') returning id`,
      [ws, request.rows[0].id, userId],
    );
    return {
      campaignId: campaign.rows[0].id as string,
      versionId: version.rows[0].id as string,
      decisionId: decision.rows[0].id as string,
    };
  });
}

let chainA: Chain;
let chainB: Chain;

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${A}::uuid, 'pub-invariants-A'), (${B}::uuid, 'pub-invariants-B') on conflict do nothing`,
  );
  const userA = await seedUser("pub-invariants-A");
  const userB = await seedUser("pub-invariants-B");
  chainA = await seedChain(A, userA);
  chainB = await seedChain(B, userB);
});

afterAll(async () => {
  // publication rows are cleaned up (unlike the rest of the seeded chain,
  // which follows this repo's existing convention of leaving fixture rows
  // in the persistent dev database) because a later migration adds a CHECK
  // tying content_hash to publication_content; leftover rows with
  // placeholder hashes would fail that CHECK's validation on ALTER TABLE.
  await adminPool.query(`delete from publication where workspace_id in ($1,$2)`, [A, B]);
  await pool.end();
  await adminPool.end();
});

function insertPublication(
  ws: string,
  overrides: Partial<{
    campaignId: string;
    versionId: string;
    decisionId: string | null;
    content: string;
    idempotencyKey: string;
  }> = {},
): Promise<unknown> {
  const chain = ws === A ? chainA : chainB;
  const campaignId = overrides.campaignId ?? chain.campaignId;
  const versionId = overrides.versionId ?? chain.versionId;
  const decisionId = overrides.decisionId === undefined ? chain.decisionId : overrides.decisionId;
  const content = overrides.content ?? "the real published text";
  const idempotencyKey = overrides.idempotencyKey ?? `pub-key-${Date.now()}-${Math.random()}`;
  return withTenant(pool, ws, (tx) =>
    tx.query(
      `insert into publication
         (id, workspace_id, campaign_id, content_version_id, approval_decision_id,
          publication_content, content_hash, idempotency_key, target_channel, state)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, $7, $6, 'meta_page', 'prepared')`,
      [ws, campaignId, versionId, decisionId, content, idempotencyKey, sha256Hex(content)],
    ));
}

describe("publication — row level security", () => {
  it("is enabled and forced", async () => {
    const r = await db.execute(
      sql`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'publication'`,
    );
    const rows = r.rows as { relrowsecurity: boolean; relforcerowsecurity: boolean }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.relrowsecurity).toBe(true);
    expect(rows[0]!.relforcerowsecurity).toBe(true);
  });
});

describe("E3: a publication requires a recorded approval decision", () => {
  it("refuses a NULL approval_decision_id (not-null)", async () => {
    await expect(insertPublication(A, { decisionId: null })).rejects.toThrow(/null value|not-null/i);
  });

  it("refuses an approval_decision_id belonging to another workspace (composite FK)", async () => {
    await expect(insertPublication(B, { decisionId: chainA.decisionId })).rejects.toThrow(
      /foreign key|violates/i,
    );
  });

  it("still allows a publication whose approval_decision_id is its own workspace's decision", async () => {
    await insertPublication(A);
  });
});

describe("E3: publication_content cannot be blank", () => {
  it("refuses an empty string", async () => {
    await expect(insertPublication(A, { content: "" })).rejects.toThrow(/check|violates/i);
  });

  it("refuses a whitespace-only string", async () => {
    await expect(insertPublication(A, { content: "   " })).rejects.toThrow(/check|violates/i);
  });

  it("refuses a string made only of tabs and newlines", async () => {
    await expect(insertPublication(A, { content: "\t\n" })).rejects.toThrow(/check|violates/i);
  });
});

describe("idempotency_key uniqueness", () => {
  it("refuses two publications sharing an idempotency_key", async () => {
    const key = `dup-pub-key-${Date.now()}-${Math.random()}`;
    await insertPublication(A, { idempotencyKey: key });
    await expect(insertPublication(A, { idempotencyKey: key })).rejects.toThrow(/unique|duplicate/i);
  });
});

describe("cross-workspace composite FKs on campaign and content_version", () => {
  it("refuses a publication in workspace B pointing at workspace A's campaign", async () => {
    await expect(insertPublication(B, { campaignId: chainA.campaignId })).rejects.toThrow(
      /foreign key|violates/i,
    );
  });

  it("refuses a publication in workspace B pointing at workspace A's content_version", async () => {
    await expect(insertPublication(B, { versionId: chainA.versionId })).rejects.toThrow(
      /foreign key|violates/i,
    );
  });
});
