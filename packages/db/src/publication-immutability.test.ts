// Fix round 1 on Task 9. The reviewer proved live that an UPDATE issued by
// smos_app inside an ordinary tenant-scoped transaction could change
// publication_content AND content_hash together, leaving the row internally
// consistent -- P4's drift check (which just recomputes the hash and
// compares it to the stored one) would pass trivially on a row like that,
// because it only ever proves the row agrees with itself, never that the
// text still matches what the human approved via approval_decision_id. A
// second, smaller hole: content_hash was never validated at INSERT either,
// so a completely fabricated hash (e.g. the literal string 'deadbeef') was
// accepted.
//
// This file proves both are closed by infra/migrations/0011_publication_immutability.sql:
//   1. A column-selective BEFORE UPDATE trigger refuses any change to
//      publication_content, content_hash, approval_decision_id,
//      content_version_id or idempotency_key -- individually, and (the
//      exact attack the reviewer found) in combination -- while leaving
//      state, external_id, permalink, evidence and updated_at freely
//      updatable, because P4 drives the execution lifecycle through them.
//   2. A CHECK ties content_hash to publication_content via pgcrypto's
//      digest(), so a fabricated or stale hash cannot be inserted at all.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { buildPublication, newId, type ContentVersion, type Id } from "@smos/domain";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);

const adminUrl =
  process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);

const WS = "88888888-8888-7888-8888-888888888888";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A real user, enrolled in `workspaceId`. The membership half is required by
 * 0037_approval_actor_must_be_a_member.sql: approval_decision
 * (workspace_id, actor_user_id) is a composite foreign key onto
 * workspace_member (workspace_id, user_id), so a bare user_account row can
 * no longer be named as an approver. Seeded through the migration role --
 * smos_app has no INSERT on workspace_member, deliberately (0037's LOCK 2).
 */
async function seedUser(label: string, workspaceId: string): Promise<string> {
  const r = await adminPool.query(
    `insert into user_account (id,email,name) values (gen_random_uuid(),$1,$2) returning id`,
    [`${label}-${Date.now()}-${Math.random()}@test.local`, label],
  );
  const userId = r.rows[0].id as string;
  await adminPool.query(
    `insert into workspace_member (id, workspace_id, user_id, role) values (gen_random_uuid(), $1, $2, 'owner')`,
    [workspaceId, userId],
  );
  return userId;
}

interface Chain {
  campaignId: string;
  versionId: string;
  decisionId: string;
  // A second, equally real version/decision pair in the SAME workspace, so
  // that redirecting a publication at either one is refused because of the
  // immutability trigger specifically -- not incidentally, because the new
  // target doesn't exist or belongs to another workspace (that case is
  // already covered by publication-invariants.test.ts).
  versionId2: string;
  decisionId2: string;
}

async function seedChain(ws: string, userId: string): Promise<Chain> {
  return withTenant(pool, ws, async (tx) => {
    const goal = await tx.query(
      `insert into goal (id, workspace_id, statement) values (gen_random_uuid(), $1, 'publication immutability probe') returning id`,
      [ws],
    );
    const campaign = await tx.query(
      `insert into campaign (id, workspace_id, goal_id, name, state) values (gen_random_uuid(), $1, $2, $3, 'WAITING_APPROVAL') returning id`,
      [ws, goal.rows[0].id, `pub-immutability-campaign ${Date.now()}-${Math.random()}`],
    );
    const item = await tx.query(
      `insert into content_item (id, workspace_id, campaign_id, kind, title) values (gen_random_uuid(), $1, $2, 'social_post', $3) returning id`,
      [ws, campaign.rows[0].id, `pub-immutability-item ${Date.now()}-${Math.random()}`],
    );

    async function versionAndDecision(versionNumber: number, text: string) {
      const version = await tx.query(
        `insert into content_version (id, workspace_id, content_item_id, version_number, body, publication_content)
         values (gen_random_uuid(), $1, $2, $3, 'body', $4) returning id`,
        [ws, item.rows[0].id, versionNumber, text],
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
      return { versionId: version.rows[0].id as string, decisionId: decision.rows[0].id as string };
    }

    const first = await versionAndDecision(1, "the real published text");
    const second = await versionAndDecision(2, "a different, also-approved text");

    return {
      campaignId: campaign.rows[0].id as string,
      versionId: first.versionId,
      decisionId: first.decisionId,
      versionId2: second.versionId,
      decisionId2: second.decisionId,
    };
  });
}

let chain: Chain;

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${WS}::uuid, 'pub-immutability') on conflict do nothing`,
  );
  const userId = await seedUser("pub-immutability", WS);
  chain = await seedChain(WS, userId);
});

afterAll(async () => {
  await adminPool.query(`delete from publication where workspace_id = $1`, [WS]);
  await pool.end();
  await adminPool.end();
});

async function insertPublication(overrides: {
  content?: string;
  contentHash?: string;
  idempotencyKey?: string;
}): Promise<string> {
  const content = overrides.content ?? "the real published text";
  const contentHash = overrides.contentHash ?? sha256Hex(content);
  const idempotencyKey = overrides.idempotencyKey ?? `pub-immutability-key-${Date.now()}-${Math.random()}`;
  const r = await withTenant(pool, WS, (tx) =>
    tx.query(
      `insert into publication
         (id, workspace_id, campaign_id, content_version_id, approval_decision_id,
          publication_content, content_hash, idempotency_key, target_channel, state)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'meta_page', 'prepared')
       returning id`,
      [WS, chain.campaignId, chain.versionId, chain.decisionId, content, contentHash, idempotencyKey],
    ));
  return r.rows[0].id as string;
}

describe("INSERT: content_hash must match publication_content", () => {
  it("refuses a fabricated / stale hash", async () => {
    await expect(insertPublication({ contentHash: "deadbeef" })).rejects.toThrow(/publication_content_hash_check/);
  });

  it("still accepts a correctly computed hash", async () => {
    await insertPublication({});
  });

  it("accepts buildPublication's own output unmodified (domain/db round-trip)", async () => {
    const version: ContentVersion = {
      id: chain.versionId as Id,
      workspaceId: WS as Id,
      contentItemId: newId(), // irrelevant here: buildPublication never reads it, and it is not written to `publication`
      versionNumber: 1,
      body: "thân bài",
      publicationContent: "the real published text",
      citations: [],
      qualityScore: 90,
      createdAt: new Date(),
    };
    const p = buildPublication({
      workspaceId: WS as Id,
      campaignId: chain.campaignId as Id,
      contentVersion: version,
      approvalDecisionId: chain.decisionId as Id,
      targetChannel: "meta_page",
    });
    await withTenant(pool, WS, (tx) =>
      tx.query(
        `insert into publication
           (id, workspace_id, campaign_id, content_version_id, approval_decision_id,
            publication_content, content_hash, idempotency_key, target_channel, state)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          p.id,
          p.workspaceId,
          p.campaignId,
          p.contentVersionId,
          p.approvalDecisionId,
          p.publicationContent,
          p.contentHash,
          p.idempotencyKey,
          p.targetChannel,
          p.state,
        ],
      ));
  });
});

describe("UPDATE: the five core fields are immutable", () => {
  it("refuses changing publication_content alone", async () => {
    const id = await insertPublication({ idempotencyKey: `core-content-only-${Date.now()}-${Math.random()}` });
    await expect(
      withTenant(pool, WS, (tx) =>
        tx.query(`update publication set publication_content = 'TAMPERED' where id = $1 and workspace_id = $2`, [
          id,
          WS,
        ])),
    ).rejects.toThrow(/immutable|permission denied/i);
  });

  // The exact attack the reviewer proved works today: change both columns
  // together so the row stays internally self-consistent (a correct hash
  // for the new, tampered text). P4's drift check alone cannot see this --
  // it only recomputes the hash and compares it to what's stored, and both
  // would agree. Only a trigger that refuses the edit at all can stop it.
  it("refuses changing publication_content AND content_hash together, even when the pair stays internally consistent", async () => {
    const id = await insertPublication({ idempotencyKey: `core-both-${Date.now()}-${Math.random()}` });
    const tamperedText = "TAMPERED TEXT, NEVER APPROVED";
    await expect(
      withTenant(pool, WS, (tx) =>
        tx.query(
          `update publication set publication_content = $1, content_hash = $2 where id = $3 and workspace_id = $4`,
          [tamperedText, sha256Hex(tamperedText), id, WS],
        )),
    ).rejects.toThrow(/immutable|permission denied/i);
  });

  it("refuses changing approval_decision_id, even to another real decision in the same workspace", async () => {
    const id = await insertPublication({ idempotencyKey: `core-decision-${Date.now()}-${Math.random()}` });
    await expect(
      withTenant(pool, WS, (tx) =>
        tx.query(`update publication set approval_decision_id = $1 where id = $2 and workspace_id = $3`, [
          chain.decisionId2,
          id,
          WS,
        ])),
    ).rejects.toThrow(/immutable|permission denied/i);
  });

  it("refuses changing content_version_id, even to another real version in the same workspace", async () => {
    const id = await insertPublication({ idempotencyKey: `core-version-${Date.now()}-${Math.random()}` });
    await expect(
      withTenant(pool, WS, (tx) =>
        tx.query(`update publication set content_version_id = $1 where id = $2 and workspace_id = $3`, [
          chain.versionId2,
          id,
          WS,
        ])),
    ).rejects.toThrow(/immutable|permission denied/i);
  });

  it("refuses changing idempotency_key", async () => {
    const id = await insertPublication({ idempotencyKey: `core-idem-${Date.now()}-${Math.random()}` });
    await expect(
      withTenant(pool, WS, (tx) =>
        tx.query(`update publication set idempotency_key = $1 where id = $2 and workspace_id = $3`, [
          `changed-${Date.now()}-${Math.random()}`,
          id,
          WS,
        ])),
    ).rejects.toThrow(/immutable|permission denied/i);
  });
});

describe("UPDATE: the execution-lifecycle fields stay freely updatable", () => {
  it("allows state to move from prepared to executing, and external_id/permalink/evidence to be set", async () => {
    const id = await insertPublication({ idempotencyKey: `lifecycle-${Date.now()}-${Math.random()}` });
    await withTenant(pool, WS, (tx) =>
      tx.query(
        `update publication
           set state = 'executing', external_id = 'ext-123', permalink = 'https://example.test/p/123',
               evidence = '{"attempt":1}'::jsonb
         where id = $1 and workspace_id = $2`,
        [id, WS],
      ));
    const r = await withTenant(pool, WS, (tx) =>
      tx.query(`select state, external_id, permalink, evidence from publication where id = $1`, [id]));
    expect(r.rows[0].state).toBe("executing");
    expect(r.rows[0].external_id).toBe("ext-123");
    expect(r.rows[0].permalink).toBe("https://example.test/p/123");
    expect(r.rows[0].evidence).toEqual({ attempt: 1 });
  });
});
