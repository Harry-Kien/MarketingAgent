import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { newId } from "@smos/domain";
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
let campaignId: string;
let versionId: string;

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${WS}::uuid, 'approval-invariants') on conflict do nothing`,
  );

  // Seed a full chain: goal -> campaign -> content_item -> content_version
  // -> approval_request, all scoped to WS via withTenant so RLS applies the
  // same way it would for the application.
  ({ requestId, campaignId, versionId } = await withTenant(pool, WS, async (tx) => {
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
    return {
      requestId: request.rows[0].id as string,
      campaignId: campaign.rows[0].id as string,
      versionId: version.rows[0].id as string,
    };
  }));
});

/**
 * approval_request_id is UNIQUE on approval_decision, so any test that
 * inserts a decision beyond the first against `requestId` needs a fresh
 * request of its own.
 */
async function freshRequestId(): Promise<string> {
  return withTenant(pool, WS, (tx) =>
    tx.query(
      `insert into approval_request (id, workspace_id, campaign_id, content_version_id, target_channel)
       values (gen_random_uuid(), $1, $2, $3, 'meta_page') returning id`,
      [WS, campaignId, versionId],
    ).then((r) => r.rows[0].id as string));
}

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

  // Fix round 1: btrim(reason) with no second argument strips only ASCII
  // spaces (U+0020), not tabs or newlines, so a reason made entirely of
  // E'\t\n' passed the old CHECK while decideApproval's `.trim()` in
  // packages/domain/src/approval.ts would reject the identical string.
  // The database must refuse exactly what the domain refuses.
  it("refuses a reason made only of tabs and newlines, not just plain spaces", async () => {
    const userId = await seedUser("whitespace-reason-probe");
    const reqId = await freshRequestId();
    await expect(withTenant(pool, WS, (tx) => tx.query(
      `insert into approval_decision (id,workspace_id,approval_request_id,actor_user_id,decision,reason)
       values (gen_random_uuid(),$1,$2,$3,'approve',$4)`, [WS, reqId, userId, "\t\n"],
    ))).rejects.toThrow(/check|violates/i);
  });
});

// Fix round 1, LOW: pins the permission state that is the other half of
// E4's first lock. The foreign key to user_account only stops an agent
// because an agent cannot make itself a user_account row; that in turn
// depends entirely on smos_app never having been granted INSERT there. If
// a future migration granted it, an agent could manufacture its own "user"
// row and satisfy the foreign key. This test fails loudly the moment that
// happens, rather than letting the regression go unnoticed.
describe("E4 lock 1's other half: smos_app cannot provision its own user_account row", () => {
  it("smos_app has no INSERT privilege on user_account", async () => {
    const r = await adminPool.query(
      `select privilege_type from information_schema.role_table_grants
       where table_name = 'user_account' and grantee = 'smos_app'`,
    );
    const privileges = r.rows.map((row: { privilege_type: string }) => row.privilege_type);
    expect(privileges).not.toContain("INSERT");
    // SELECT is the only grant 0001_core_tenancy.sql gives smos_app on this
    // table; asserting the full set (not just the absence of INSERT) means
    // a future UPDATE/DELETE grant would also fail this test.
    expect(privileges).toEqual(["SELECT"]);
  });

  // Final whole-branch review, IMPORTANT 3. The assertion above is
  // GRANTEE-SHAPED: it reads information_schema.role_table_grants filtered to
  // `grantee = 'smos_app'`, so it only ever sees privileges granted to that
  // role BY NAME. Reproduced live against this database: the reviewer's own
  // mutation `GRANT INSERT ON user_account TO smos_app` does fail it (1 test
  // fails, not 0 as reported) -- but the one-word variant
  //
  //     GRANT INSERT ON user_account TO PUBLIC;
  //
  // gives smos_app exactly the same INSERT privilege
  // (has_table_privilege('smos_app','user_account','INSERT') = true, verified)
  // while appearing nowhere under `grantee = 'smos_app'`, and the whole suite
  // still passed 0 failures. Role membership and default privileges have the
  // same shape of gap. So 0030's protection is pinned here by what smos_app
  // can actually DO, not by who a catalog row says was granted what.
  it("smos_app cannot INSERT, UPDATE or DELETE user_account by ANY grant path (privilege, not grantee)", async () => {
    const r = await adminPool.query(
      `select has_table_privilege('smos_app', 'user_account', 'INSERT') as ins,
              has_table_privilege('smos_app', 'user_account', 'UPDATE') as upd,
              has_table_privilege('smos_app', 'user_account', 'DELETE') as del,
              has_table_privilege('smos_app', 'user_account', 'SELECT') as sel`,
    );
    // has_table_privilege resolves the EFFECTIVE privilege: direct grants,
    // grants to PUBLIC, and grants inherited through role membership all
    // read true here.
    expect(r.rows[0].ins).toBe(false);
    expect(r.rows[0].upd).toBe(false);
    expect(r.rows[0].del).toBe(false);
    // ...and SELECT is still there, so this test fails for the right reason
    // if a future migration revokes everything rather than nothing.
    expect(r.rows[0].sel).toBe(true);
  });

  it("smos_app is refused when it actually attempts to provision a user_account row", async () => {
    // The behavioural half: E4's first lock is "an agent cannot manufacture
    // the user row its approval_decision.actor_user_id would point at".
    // Proving that by running the attempt as smos_app -- the exact role every
    // agent rides on -- is the assertion that cannot be satisfied by a
    // catalog view telling a comfortable story.
    const forgedId = newId();
    try {
      await expect(
        pool.query(`insert into user_account (id, email, name) values ($1, $2, $3)`, [
          forgedId,
          `forged-approver-${forgedId}@test.local`,
          "forged approver",
        ]),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      // Survives a failing test: if the insert ever succeeds, the row is
      // removed through the migration role rather than left behind for the
      // next run to trip over.
      await adminPool.query("delete from user_account where id = $1", [forgedId]).catch(() => undefined);
    }
  });
});
