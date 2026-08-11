// Final whole-branch review, FINDING 6 (LOW, but load-bearing): the
// reviewer found `UPDATE campaign SET state = 'APPROVED'` succeeds directly
// from DRAFT as smos_app. 0005_campaign_state_check.sql's CHECK constrains
// the SET of 15 valid values but never the transitions between them, even
// though its own header claims campaign state is "never reachable via a
// general-purpose UPDATE that isn't validated" (Invariant D). This suite
// proves a database-level backstop mirroring canTransition
// (packages/domain/src/lifecycle.ts) now exists: an UPDATE that names
// campaign.state is refused unless the (OLD.state, NEW.state) pair is a
// legal transition, exactly the same rule the domain layer already applies
// in TypeScript.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { canTransition, MAIN_STATES, SIDE_STATES, type LifecycleState } from "@smos/domain";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);
const WS = "d0d0d0d0-d0d0-7d0d-8d0d-d0d0d0d0d0d0";

const ALL_STATES = [...MAIN_STATES, ...SIDE_STATES] as const;

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${WS}::uuid, 'campaign-transition-trigger') on conflict do nothing`,
  );
});

afterAll(async () => {
  await pool.end();
});

async function insertGoal(): Promise<string> {
  return withTenant(pool, WS, async (tx) => {
    const r = await tx.query(
      `insert into goal (id, workspace_id, statement) values (gen_random_uuid(), $1, 'transition trigger probe') returning id`,
      [WS],
    );
    return r.rows[0].id as string;
  });
}

/** Inserts a campaign directly at `state` (bypassing any transition check -- INSERT is untouched by this trigger, matching campaign-state-check.test.ts's existing "accepts all fifteen valid lifecycle states" precedent). */
async function insertCampaignAt(state: LifecycleState, goalId: string): Promise<string> {
  const marker = `transition-trigger-${state}-${Date.now()}-${Math.random()}`;
  return withTenant(pool, WS, async (tx) => {
    const r = await tx.query(
      `insert into campaign (id, workspace_id, goal_id, name, state) values (gen_random_uuid(), $1, $2, $3, $4) returning id`,
      [WS, goalId, marker, state],
    );
    return r.rows[0].id as string;
  });
}

async function updateState(campaignId: string, to: LifecycleState): Promise<void> {
  await withTenant(pool, WS, (tx) =>
    tx.query(`update campaign set state = $1 where id = $2`, [to, campaignId]));
}

describe("campaign.state — transition-validating trigger (Invariant D)", () => {
  it("the exact reviewer reproduction: UPDATE state = 'APPROVED' directly from DRAFT is refused", async () => {
    const goalId = await insertGoal();
    const campaignId = await insertCampaignAt("DRAFT", goalId);
    await expect(updateState(campaignId, "APPROVED")).rejects.toThrow(/transition|not allowed/i);
  });

  it("a legal single-step forward transition (DRAFT -> RESEARCHING) succeeds", async () => {
    const goalId = await insertGoal();
    const campaignId = await insertCampaignAt("DRAFT", goalId);
    await updateState(campaignId, "RESEARCHING");
    const after = await withTenant(pool, WS, (tx) =>
      tx.query(`select state from campaign where id = $1`, [campaignId]));
    expect(after.rows[0].state).toBe("RESEARCHING");
  });

  it("skipping ahead in the main sequence (DRAFT -> IN_PROGRESS) is refused", async () => {
    const goalId = await insertGoal();
    const campaignId = await insertCampaignAt("DRAFT", goalId);
    await expect(updateState(campaignId, "IN_PROGRESS")).rejects.toThrow(/transition|not allowed/i);
  });

  it("a rework edge (INTERNAL_REVIEW -> IN_PROGRESS) succeeds", async () => {
    const goalId = await insertGoal();
    const campaignId = await insertCampaignAt("INTERNAL_REVIEW", goalId);
    await updateState(campaignId, "IN_PROGRESS");
  });

  it("moving to a side state (IN_PROGRESS -> BLOCKED) succeeds", async () => {
    const goalId = await insertGoal();
    const campaignId = await insertCampaignAt("IN_PROGRESS", goalId);
    await updateState(campaignId, "BLOCKED");
  });

  it("recovering from BLOCKED back into the pre-approval sequence (BLOCKED -> PLANNED) succeeds", async () => {
    const goalId = await insertGoal();
    const campaignId = await insertCampaignAt("BLOCKED", goalId);
    await updateState(campaignId, "PLANNED");
  });

  it("BLOCKED cannot shortcut past approval (BLOCKED -> APPROVED is refused)", async () => {
    const goalId = await insertGoal();
    const campaignId = await insertCampaignAt("BLOCKED", goalId);
    await expect(updateState(campaignId, "APPROVED")).rejects.toThrow(/transition|not allowed/i);
  });

  it("a terminal state (COMPLETED) can never transition again", async () => {
    const goalId = await insertGoal();
    const campaignId = await insertCampaignAt("COMPLETED", goalId);
    await expect(updateState(campaignId, "MEASURING")).rejects.toThrow(/transition|not allowed/i);
  });

  // Final whole-branch review round 2. Originally this trigger raised on
  // NEW.state = OLD.state, mirroring canTransition's own from === to
  // rule -- but canTransition judges a REQUESTED transition, while this
  // trigger fires on any UPDATE that merely NAMES the state column,
  // including one where nothing about state was actually requested to
  // change (an ORM's full-row UPDATE that lists every column, most of them
  // unchanged, is the standard shape once real persistence code exists).
  // Rejecting that would make the very first full-row UPDATE -- changing
  // only `name`, say, while state is carried along unchanged in the same
  // SET clause -- fail outright with no real transition ever attempted.
  // The trigger now treats an unchanged value as a no-op (allowed), while
  // a genuinely requested but illegal transition is still refused.
  it("setting state to its own current value is a no-op and is allowed", async () => {
    const goalId = await insertGoal();
    const campaignId = await insertCampaignAt("PLANNED", goalId);
    await updateState(campaignId, "PLANNED");
    const after = await withTenant(pool, WS, (tx) =>
      tx.query(`select state from campaign where id = $1`, [campaignId]));
    expect(after.rows[0].state).toBe("PLANNED");
  });

  it("a full-row-shaped UPDATE that changes name but carries state unchanged in the same SET clause succeeds", async () => {
    const goalId = await insertGoal();
    const campaignId = await insertCampaignAt("PLANNED", goalId);
    const newName = `renamed-${Date.now()}-${Math.random()}`;
    await withTenant(pool, WS, (tx) =>
      tx.query(`update campaign set name = $1, state = state where id = $2`, [newName, campaignId]));
    const after = await withTenant(pool, WS, (tx) =>
      tx.query(`select name, state from campaign where id = $1`, [campaignId]));
    expect(after.rows[0].name).toBe(newName);
    expect(after.rows[0].state).toBe("PLANNED");
  });

  it("a real illegal transition inside the same kind of full-row UPDATE is still refused", async () => {
    const goalId = await insertGoal();
    const campaignId = await insertCampaignAt("DRAFT", goalId);
    await expect(
      withTenant(pool, WS, (tx) =>
        tx.query(`update campaign set name = name, state = $1 where id = $2`, ["APPROVED", campaignId])),
    ).rejects.toThrow(/transition|not allowed/i);
  });

  // Exhaustive cross-check: every (from, to) pair the domain's canTransition
  // permits must succeed at the database, and every pair it refuses must be
  // refused at the database too -- the trigger is a mirror, not an
  // independent guess.
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      if (from === to) continue;
      const expectAllowed = canTransition(from, to);
      it(`${expectAllowed ? "allows" : "refuses"} ${from} -> ${to} (matches domain canTransition)`, async () => {
        const goalId = await insertGoal();
        const campaignId = await insertCampaignAt(from, goalId);
        if (expectAllowed) {
          await updateState(campaignId, to);
          const after = await withTenant(pool, WS, (tx) =>
            tx.query(`select state from campaign where id = $1`, [campaignId]));
          expect(after.rows[0].state).toBe(to);
        } else {
          await expect(updateState(campaignId, to)).rejects.toThrow(/transition|not allowed/i);
        }
      });
    }
  }
});
