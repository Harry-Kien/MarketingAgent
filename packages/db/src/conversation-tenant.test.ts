// M2B Task 1: dedicated, hand-written adversarial proof for the three new
// conversation-domain tables, mirroring campaign-tenant.test.ts's shape.
// Does NOT replace cross-tenant.test.ts's exhaustive, catalog-driven suite
// (updated in this same task) -- that suite proves isolation for every
// workspace-owned table generically; this file proves it for THIS domain
// specifically, with real Zalo-shaped data, and is what a reviewer of this
// task will actually read.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);
const A = "77777777-7777-7777-8777-777777777777";
const B = "88888888-8888-7888-8888-888888888888";

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${A}::uuid, 'conversation-tenant-A'), (${B}::uuid, 'conversation-tenant-B') on conflict do nothing`,
  );
});

afterAll(async () => {
  await pool.end();
});

describe("customer_contact / conversation / message -- row level security", () => {
  it("is enabled and forced on all three tables", async () => {
    const r = await db.execute(
      sql`select relname, relrowsecurity, relforcerowsecurity from pg_class
          where relname in ('customer_contact', 'conversation', 'message')`,
    );
    const rows = r.rows as { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it("workspace B's contact, conversation and message are invisible when scoped to workspace A", async () => {
    const marker = `B-only contact ${Date.now()}`;
    const ids = await withTenant(pool, B, async (tx) => {
      const contact = await tx.query(
        `insert into customer_contact (id, workspace_id, channel, channel_contact_id, display_name)
         values (gen_random_uuid(), $1, 'zalo', $2, $3) returning id`,
        [B, `zalo-user-${Date.now()}`, marker],
      );
      const conversation = await tx.query(
        `insert into conversation (id, workspace_id, customer_contact_id) values (gen_random_uuid(), $1, $2) returning id`,
        [B, contact.rows[0].id],
      );
      const message = await tx.query(
        `insert into message (id, workspace_id, conversation_id, direction, channel_message_id, body)
         values (gen_random_uuid(), $1, $2, 'inbound', $3, 'xin chao') returning id`,
        [B, conversation.rows[0].id, `zmsg-${Date.now()}`],
      );
      return {
        conversationId: conversation.rows[0].id as string,
        messageId: message.rows[0].id as string,
      };
    });

    const seenFromA = await withTenant(pool, A, (tx) =>
      tx.query("select count(*)::int as n from customer_contact where display_name = $1", [marker]));
    expect(seenFromA.rows[0].n).toBe(0);

    const conversationFromA = await withTenant(pool, A, (tx) =>
      tx.query("select id from conversation where id = $1", [ids.conversationId]));
    expect(conversationFromA.rowCount).toBe(0);

    const messageFromA = await withTenant(pool, A, (tx) =>
      tx.query("select id from message where id = $1", [ids.messageId]));
    expect(messageFromA.rowCount).toBe(0);

    const seenFromB = await withTenant(pool, B, (tx) =>
      tx.query("select count(*)::int as n from customer_contact where display_name = $1", [marker]));
    expect(seenFromB.rows[0].n).toBe(1);
  });

  it("an INSERT into any of the three tables tagged with workspace B is refused while scoped to workspace A", async () => {
    // A real contact/conversation in A's OWN scope, so the composite FK
    // itself is never what refuses the write below -- RLS's WITH CHECK
    // must be the thing that fires.
    const { contactId, conversationId } = await withTenant(pool, A, async (tx) => {
      const contact = await tx.query(
        `insert into customer_contact (id, workspace_id, channel, channel_contact_id)
         values (gen_random_uuid(), $1, 'zalo', $2) returning id`,
        [A, `zalo-user-a-${Date.now()}`],
      );
      const conversation = await tx.query(
        `insert into conversation (id, workspace_id, customer_contact_id) values (gen_random_uuid(), $1, $2) returning id`,
        [A, contact.rows[0].id],
      );
      return { contactId: contact.rows[0].id as string, conversationId: conversation.rows[0].id as string };
    });

    await expect(
      withTenant(pool, A, (tx) =>
        tx.query(
          `insert into customer_contact (id, workspace_id, channel, channel_contact_id)
           values (gen_random_uuid(), $1, 'zalo', $2)`,
          [B, `cross-tenant-contact-${Date.now()}`],
        )),
    ).rejects.toThrow(/new row violates row-level security policy for table "customer_contact"/);

    await expect(
      withTenant(pool, A, (tx) =>
        tx.query(
          `insert into conversation (id, workspace_id, customer_contact_id) values (gen_random_uuid(), $1, $2)`,
          [B, contactId],
        )),
    ).rejects.toThrow(/new row violates row-level security policy for table "conversation"/);

    await expect(
      withTenant(pool, A, (tx) =>
        tx.query(
          `insert into message (id, workspace_id, conversation_id, direction, channel_message_id, body)
           values (gen_random_uuid(), $1, $2, 'inbound', $3, 'tin nhan gia')`,
          [B, conversationId, `cross-tenant-msg-${Date.now()}`],
        )),
    ).rejects.toThrow(/new row violates row-level security policy for table "message"/);
  });
});

describe("message_bumps_reply_window trigger", () => {
  it("sets last_customer_message_at and reply_window_expires_at on the conversation from an inbound message's occurred_at", async () => {
    const occurredAt = new Date("2026-08-01T00:00:00.000Z");
    const { conversationId } = await withTenant(pool, A, async (tx) => {
      const contact = await tx.query(
        `insert into customer_contact (id, workspace_id, channel, channel_contact_id)
         values (gen_random_uuid(), $1, 'zalo', $2) returning id`,
        [A, `zalo-user-trigger-${Date.now()}`],
      );
      const conversation = await tx.query(
        `insert into conversation (id, workspace_id, customer_contact_id) values (gen_random_uuid(), $1, $2) returning id`,
        [A, contact.rows[0].id],
      );
      await tx.query(
        `insert into message (id, workspace_id, conversation_id, direction, channel_message_id, body, occurred_at)
         values (gen_random_uuid(), $1, $2, 'inbound', $3, 'xin chao', $4)`,
        [A, conversation.rows[0].id, `zmsg-trigger-${Date.now()}`, occurredAt],
      );
      return { conversationId: conversation.rows[0].id as string };
    });

    const r = await withTenant(pool, A, (tx) =>
      tx.query(`select last_customer_message_at, reply_window_expires_at from conversation where id = $1`, [conversationId]));
    expect(new Date(r.rows[0].last_customer_message_at).toISOString()).toBe(occurredAt.toISOString());
    expect(new Date(r.rows[0].reply_window_expires_at).toISOString()).toBe(
      new Date(occurredAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("does not touch the deadline for an outbound message", async () => {
    const { conversationId } = await withTenant(pool, A, async (tx) => {
      const contact = await tx.query(
        `insert into customer_contact (id, workspace_id, channel, channel_contact_id)
         values (gen_random_uuid(), $1, 'zalo', $2) returning id`,
        [A, `zalo-user-outbound-${Date.now()}`],
      );
      const conversation = await tx.query(
        `insert into conversation (id, workspace_id, customer_contact_id) values (gen_random_uuid(), $1, $2) returning id`,
        [A, contact.rows[0].id],
      );
      await tx.query(
        `insert into message (id, workspace_id, conversation_id, direction, channel_message_id, body, disclosure_sent)
         values (gen_random_uuid(), $1, $2, 'outbound', $3, 'cam on ban', true)`,
        [A, conversation.rows[0].id, `zmsg-outbound-${Date.now()}`],
      );
      return { conversationId: conversation.rows[0].id as string };
    });

    const r = await withTenant(pool, A, (tx) =>
      tx.query(`select last_customer_message_at from conversation where id = $1`, [conversationId]));
    expect(r.rows[0].last_customer_message_at).toBeNull();
  });
});
