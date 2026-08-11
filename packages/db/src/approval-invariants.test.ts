import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

// DATABASE_URL connects the pool AS smos_app directly (see .env / ADR-007),
// the same non-BYPASSRLS role the application uses -- every attempt below
// that probes approval_decision runs on THIS pool, never on adminPool, so
// each attempt is exactly what the running application (or a compromised
// agent, which only ever gets to be smos_app) could actually attempt.
const url =
  process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);
const WS = "ffffffff-ffff-7fff-8fff-ffffffffffff";

// user_account has no INSERT grant for smos_app (0001_core_tenancy.sql grants
// it SELECT only) -- provisioning a real user is an administrative act, not
// something the application role (or an agent riding along on it) can do.
// Fixture user rows for the "valid path" tests below are therefore seeded
// through the migration owner, exactly like scripts/apply-migrations.mjs
// does, and only ever used to obtain an id; the actual approval_decision
// attempts stay on `pool` (smos_app) throughout.
const adminUrl =
  process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);

async function seedUser(label: string): Promise<string> {
  const r = await adminPool.query(
    `insert into user_account (id,email,name) values (gen_random_uuid(),$1,$2) returning id`,
    [`${label}-${Date.now()}-${Math.random()}@test.local`, label],
  );
  return r.rows[0].id as string;
}

let requestId: string;

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${WS}::uuid, 'approval-invariants') on conflict do nothing`,
  );

  // Seed a full chain: goal -> campaign -> content_item -> content_version
  // -> approval_request, all scoped to WS via withTenant so RLS applies the
  // same way it would for the application.
  requestId = await withTenant(pool, WS, async (tx) => {
    const goal = await tx.query(
      `insert into goal (id, workspace_id, statement) values (gen_random_uuid(), $1, 'approval invariants probe') returning id`,
      [WS],
    );
    const campaign = await tx.query(
      `insert into campaign (id, workspace_id, goal_id, name, state) values (gen_random_uuid(), $1, $2, $3, 'WAITING_APPROVAL') returning id`,
      [WS, goal.rows[0].id, `approval-invariants-campaign ${Date.now()}-${Math.random()}`],
    );
    const item = await tx.query(
      `insert into content_item (id, workspace_id, campaign_id, kind, title) values (gen_random_uuid(), $1, $2, 'social_post', $3) returning id`,
      [WS, campaign.rows[0].id, `approval-invariants-item ${Date.now()}-${Math.random()}`],
    );
    const version = await tx.query(
      `insert into content_version (id, workspace_id, content_item_id, version_number, body, publication_content)
       values (gen_random_uuid(), $1, $2, 1, 'body', 'publication body') returning id`,
      [WS, item.rows[0].id],
    );
    const request = await tx.query(
      `insert into approval_request (id, workspace_id, campaign_id, content_version_id, target_channel)
       values (gen_random_uuid(), $1, $2, $3, 'meta_page') returning id`,
      [WS, campaign.rows[0].id, version.rows[0].id],
    );
    return request.rows[0].id as string;
  });
});

afterAll(async () => {
  await pool.end();
  await adminPool.end();
});

describe("approval_request / approval_decision — row level security", () => {
  it("is enabled and forced on both tables", async () => {
    const r = await db.execute(
      sql`select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('approval_request', 'approval_decision')`,
    );
    const rows = r.rows as { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });
});

describe("approval invariants enforced by the database (E4)", () => {
  it("refuses a decision whose actor is not a real user row (foreign key)", async () => {
    await expect(withTenant(pool, WS, (tx) => tx.query(
      `insert into approval_decision (id,workspace_id,approval_request_id,actor_user_id,decision,reason)
       values (gen_random_uuid(),$1,$2,gen_random_uuid(),'approve','agent tried')`, [WS, requestId],
    ))).rejects.toThrow(/foreign key|violates/i);
  });

  it("refuses actor_kind other than user (CHECK), even with a real user row", async () => {
    const userId = await seedUser("agent-kind-probe");
    await expect(withTenant(pool, WS, (tx) => tx.query(
      `insert into approval_decision (id,workspace_id,approval_request_id,actor_user_id,actor_kind,decision,reason)
       values (gen_random_uuid(),$1,$2,$3,'agent','approve','x')`, [WS, requestId, userId],
    ))).rejects.toThrow(/check|violates/i);
  });

  it("refuses actor_kind 'system' (CHECK), even with a real user row", async () => {
    const userId = await seedUser("system-kind-probe");
    await expect(withTenant(pool, WS, (tx) => tx.query(
      `insert into approval_decision (id,workspace_id,approval_request_id,actor_user_id,actor_kind,decision,reason)
       values (gen_random_uuid(),$1,$2,$3,'system','approve','x')`, [WS, requestId, userId],
    ))).rejects.toThrow(/check|violates/i);
  });

  it("refuses a blank reason", async () => {
    const userId = await seedUser("blank-reason-probe");
    await expect(withTenant(pool, WS, (tx) => tx.query(
      `insert into approval_decision (id,workspace_id,approval_request_id,actor_user_id,decision,reason)
       values (gen_random_uuid(),$1,$2,$3,'approve','   ')`, [WS, requestId, userId],
    ))).rejects.toThrow(/check|violates/i);
  });

  it("refuses two decisions on one request", async () => {
    const userId = await seedUser("double-decision-probe");
    await withTenant(pool, WS, (tx) => tx.query(
      `insert into approval_decision (id,workspace_id,approval_request_id,actor_user_id,decision,reason)
       values (gen_random_uuid(),$1,$2,$3,'approve','ok')`, [WS, requestId, userId]));
    await expect(withTenant(pool, WS, (tx) => tx.query(
      `insert into approval_decision (id,workspace_id,approval_request_id,actor_user_id,decision,reason)
       values (gen_random_uuid(),$1,$2,$3,'reject','again')`, [WS, requestId, userId],
    ))).rejects.toThrow(/unique|duplicate/i);
  });

  it("refuses UPDATE and DELETE on a recorded decision", async () => {
    await expect(withTenant(pool, WS, (tx) => tx.query(`update approval_decision set decision='reject' where workspace_id = $1`, [WS])))
      .rejects.toThrow(/immutable|permission denied/i);
    await expect(withTenant(pool, WS, (tx) => tx.query(`delete from approval_decision where workspace_id = $1`, [WS])))
      .rejects.toThrow(/immutable|permission denied/i);
  });
});
