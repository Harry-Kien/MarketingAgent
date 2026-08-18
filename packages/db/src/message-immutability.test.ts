// M2B Task 2: 0041_message_immutable.sql's actual proof, direct SQL as
// smos_app -- the same shape publication-immutability.test.ts and
// webhook-delivery-nonce.test.ts already use for their own immutable
// tables. 0040 granted smos_app UPDATE on message so this file's
// assertions genuinely exercise the trigger, not merely a missing grant.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);
const WS = "99999999-9999-7999-8999-999999999999";

beforeAll(async () => {
  await db.execute(sql`insert into workspace (id, name) values (${WS}::uuid, 'message-immutability') on conflict do nothing`);
});

afterAll(async () => {
  await pool.end();
});

async function seedMessage(): Promise<string> {
  return withTenant(pool, WS, async (tx) => {
    const contact = await tx.query(
      `insert into customer_contact (id, workspace_id, channel, channel_contact_id)
       values (gen_random_uuid(), $1, 'zalo', $2) returning id`,
      [WS, `zalo-user-immut-${Date.now()}-${Math.random()}`],
    );
    const conversation = await tx.query(
      `insert into conversation (id, workspace_id, customer_contact_id) values (gen_random_uuid(), $1, $2) returning id`,
      [WS, contact.rows[0].id],
    );
    const message = await tx.query(
      `insert into message (id, workspace_id, conversation_id, direction, channel_message_id, body)
       values (gen_random_uuid(), $1, $2, 'outbound', $3, 'nguyen ban dau') returning id`,
      [WS, conversation.rows[0].id, `zmsg-immut-${Date.now()}-${Math.random()}`],
    );
    return message.rows[0].id as string;
  });
}

describe("message: immutable once written", () => {
  it("refuses to change body after insert", async () => {
    const id = await seedMessage();
    await expect(
      withTenant(pool, WS, (tx) => tx.query(`update message set body = 'TAMPERED' where id = $1`, [id])),
    ).rejects.toThrow(/immutable|permission denied/i);
  });

  it("refuses to change channel_message_id after insert", async () => {
    const id = await seedMessage();
    await expect(
      withTenant(pool, WS, (tx) =>
        tx.query(`update message set channel_message_id = $1 where id = $2`, [`retargeted-${Date.now()}`, id])),
    ).rejects.toThrow(/immutable|permission denied/i);
  });

  it("refuses to flip disclosure_sent after insert", async () => {
    const id = await seedMessage();
    await expect(
      withTenant(pool, WS, (tx) => tx.query(`update message set disclosure_sent = true where id = $1`, [id])),
    ).rejects.toThrow(/immutable|permission denied/i);
  });

  it("still allows a fresh INSERT (the trigger only refuses UPDATE)", async () => {
    await expect(seedMessage()).resolves.toBeTruthy();
  });
});
