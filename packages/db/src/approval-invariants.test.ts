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

/**
 * A real user row with NO membership anywhere. This is the actor the final
 * whole-branch review's CRITICAL 2 kill chain used: a genuine row in
 * user_account, so approval_decision's foreign key to that table is
 * satisfied, belonging to no workspace at all.
 */
async function seedOutsider(label: string): Promise<string> {
  const r = await adminPool.query(
    `insert into user_account (id,email,name) values (gen_random_uuid(),$1,$2) returning id`,
    [`${label}-${Date.now()}-${Math.random()}@test.local`, label],
  );
  return r.rows[0].id as string;
}

/**
 * A real user who is a MEMBER of WS. Every existing test in this file that
 * needs a valid actor uses this: after the final whole-branch review's
 * CRITICAL 2 fix, `actor_user_id` alone is no longer enough to record a
 * decision -- the actor must also hold a workspace_member row in the
 * workspace being approved for -- so a bare user_account row would make
 * those tests fail (or, worse, pass against the wrong constraint) for a
 * reason that has nothing to do with what each of them is actually about.
 */
async function seedUser(label: string): Promise<string> {
  const userId = await seedOutsider(label);
  await adminPool.query(
    `insert into workspace_member (id, workspace_id, user_id, role) values (gen_random_uuid(), $1, $2, 'owner')
     on conflict do nothing`,
    [WS, userId],
  );
  return userId;
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
  // Survives a FAILING test. The CRITICAL 2 block below deliberately tries
  // to record decisions by actors with no membership in WS. If that guard
  // ever regresses, those rows would be committed -- and because
  // approval_decision is append-only for every role (0007), they could not
  // be removed afterwards, permanently blocking 0037's composite foreign
  // key from being validated on a fresh database. They are cleaned up here
  // instead, scoped to this file's own workspace, with 0007's trigger
  // briefly disabled through the migration role (0031's own backfill uses
  // the same technique, and it is the only way to delete from this
  // deliberately immutable table at all).
  await adminPool.query("alter table approval_decision disable trigger approval_decision_no_mutation").catch(() => undefined);
  await adminPool
    .query(
      `delete from approval_decision d
        where d.workspace_id = $1
          and not exists (select 1 from workspace_member m
                           where m.workspace_id = d.workspace_id and m.user_id = d.actor_user_id)`,
      [WS],
    )
    .catch(() => undefined);
  await adminPool.query("alter table approval_decision enable trigger approval_decision_no_mutation").catch(() => undefined);
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

// Final whole-branch review, CRITICAL 2: "nothing binds the approver to the
// workspace, and the kill chain holds."
//
// approval_decision.actor_user_id's foreign key references user_account(id)
// and NOTHING ELSE. It proves the actor is a real human somewhere in the
// system; it says nothing whatsoever about that human having any authority
// in the workspace being approved for. handlePublish (apps/worker/src/
// handlers/publish.ts) then checks the actor's SHAPE -- isId(actorUserId),
// decision === 'approve', workspace match, content-version match, channel
// match, content-hash match -- and never their AUTHORITY. Reproduced end to
// end by the reviewer from one smos_app SQL connection: pick any
// app.workspace_id, insert an approval_request, insert an approval_decision
// naming ANY row in user_account (including a user with no membership in
// that workspace at all), insert a publication, and handlePublish passed
// every gate and published "AGENT-GENERATED TEXT NO HUMAN EVER SAW".
//
// The binding must be at the database, not in TypeScript: this project's
// governing failure mode, now five times over, is an invariant that lived
// only in application code and was defeated by direct SQL as smos_app.
describe("CRITICAL 2: the recorded approver must be a member of the workspace being approved for", () => {
  it("refuses a decision by a real user_account row with no membership anywhere", async () => {
    const outsider = await seedOutsider("critical2-outsider");
    const reqId = await freshRequestId();
    await expect(
      withTenant(pool, WS, (tx) =>
        tx.query(
          `insert into approval_decision (id,workspace_id,approval_request_id,actor_user_id,decision,reason)
           values (gen_random_uuid(),$1,$2,$3,'approve','AGENT-GENERATED TEXT NO HUMAN EVER SAW')`,
          [WS, reqId, outsider],
        )),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("refuses a decision by a user who is a member of a DIFFERENT workspace", async () => {
    // The sharper case: not "no authority anywhere" but "authority somewhere
    // else". A membership-shaped check that forgot the workspace_id half
    // would pass this one.
    const otherWorkspaceId = newId();
    const outsider = await seedOutsider("critical2-other-workspace-member");
    await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [
      otherWorkspaceId,
      `critical2-other-${otherWorkspaceId}`,
    ]);
    try {
      await adminPool.query(
        `insert into workspace_member (id, workspace_id, user_id, role) values (gen_random_uuid(), $1, $2, 'owner')`,
        [otherWorkspaceId, outsider],
      );
      const reqId = await freshRequestId();
      await expect(
        withTenant(pool, WS, (tx) =>
          tx.query(
            `insert into approval_decision (id,workspace_id,approval_request_id,actor_user_id,decision,reason)
             values (gen_random_uuid(),$1,$2,$3,'approve','member of somewhere else')`,
            [WS, reqId, outsider],
          )),
      ).rejects.toThrow(/foreign key|violates/i);
    } finally {
      await adminPool
        .query("delete from workspace_member where workspace_id = $1", [otherWorkspaceId])
        .catch(() => undefined);
      await adminPool.query("delete from workspace where id = $1", [otherWorkspaceId]).catch(() => undefined);
    }
  });

  it("accepts a decision by an actual member of the workspace -- the guard refuses authority, not approvals", async () => {
    const member = await seedUser("critical2-real-member");
    const reqId = await freshRequestId();
    const r = await withTenant(pool, WS, (tx) =>
      tx.query(
        `insert into approval_decision (id,workspace_id,approval_request_id,actor_user_id,decision,reason)
         values (gen_random_uuid(),$1,$2,$3,'approve','a real member approved this') returning id`,
        [WS, reqId, member],
      ));
    expect(r.rows[0].id).toBeTruthy();
  });

  // Binding the approver to workspace_member is worth nothing if the role
  // being defended against can WRITE workspace_member. 0029 granted smos_app
  // INSERT and UPDATE there, so a compromised agent could have inserted
  // `(current workspace, any existing user_account row)` inside its own RLS
  // scope and then approved as that person -- the identical kill chain, one
  // statement longer. Membership is an administrative act, exactly like
  // provisioning the user_account row itself (0030).
  it("smos_app cannot grant membership by ANY grant path (privilege, not grantee)", async () => {
    const r = await adminPool.query(
      `select has_table_privilege('smos_app', 'workspace_member', 'INSERT') as ins,
              has_table_privilege('smos_app', 'workspace_member', 'UPDATE') as upd,
              has_table_privilege('smos_app', 'workspace_member', 'DELETE') as del,
              has_table_privilege('smos_app', 'workspace_member', 'SELECT') as sel`,
    );
    expect(r.rows[0].ins).toBe(false);
    expect(r.rows[0].upd).toBe(false);
    expect(r.rows[0].del).toBe(false);
    expect(r.rows[0].sel).toBe(true);
  });

  it("smos_app is refused when it actually attempts to enrol a user in its own workspace", async () => {
    const outsider = await seedOutsider("critical2-self-enrol");
    const memberId = newId();
    try {
      await expect(
        withTenant(pool, WS, (tx) =>
          tx.query(
            `insert into workspace_member (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
            [memberId, WS, outsider],
          )),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await adminPool.query("delete from workspace_member where id = $1", [memberId]).catch(() => undefined);
    }
  });

  it("the kill chain stops at the decision: with no decision recorded, no publication can be built", async () => {
    // publication.approval_decision_id is NOT NULL and foreign-keyed
    // (0010_publication.sql), so a chain whose decision was refused has
    // nothing to point a publication at -- handlePublish is never reached
    // because the row it would load cannot exist. Proved rather than assumed:
    // a publication naming a decision id that was never recorded is refused
    // by the database too.
    const outsider = await seedOutsider("critical2-chain");
    const reqId = await freshRequestId();
    const forgedDecisionId = newId();
    await expect(
      withTenant(pool, WS, (tx) =>
        tx.query(
          `insert into approval_decision (id,workspace_id,approval_request_id,actor_user_id,decision,reason)
           values ($1,$2,$3,$4,'approve','forged')`,
          [forgedDecisionId, WS, reqId, outsider],
        )),
    ).rejects.toThrow(/foreign key|violates/i);

    await expect(
      withTenant(pool, WS, (tx) =>
        tx.query(
          `insert into publication (id, workspace_id, campaign_id, content_version_id, approval_decision_id,
                                    publication_content, content_hash, idempotency_key, target_channel, state)
           values (gen_random_uuid(), $1, $2, $3, $4, $5, encode(digest($5,'sha256'),'hex'), $6, 'meta_page', 'prepared')`,
          [WS, campaignId, versionId, forgedDecisionId, "AGENT-GENERATED TEXT NO HUMAN EVER SAW", newId()],
        )),
    ).rejects.toThrow(/foreign key|violates/i);
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
