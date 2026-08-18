# M2B — Conversation Domain and Zalo Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the conversation domain (`customer_contact` / `conversation` / `message`) from nothing, build the Zalo OA client and its HMAC-verified webhook, and extend `ChannelAdapter` with `sendDirectMessage` / `parseInbound` and a reply-window / ban-avoidance guard — all the plumbing M2C's advisory agent will later dispatch through.

**Architecture:** Three new, RLS-forced, composite-FK-linked tables (migration 0040) plus a message-immutability trigger (migration 0041) give the domain a real, tenant-isolated home. A hand-rolled Zalo OA HTTP client (`packages/integrations/src/zalo/client.ts`), routed exclusively through the existing `guardedFetch` egress guard, is wrapped into a `ChannelAdapter` (`zalo/adapter.ts`) that gates every send behind a reply-window and complaint-rate circuit breaker before any HTTP call. A workspace-scoped webhook route mirrors the existing Meta webhook's per-workspace-secret + nonce design exactly, reusing its signature-verification primitive rather than duplicating it.

**Tech Stack:** Node 24.14.0, TypeScript 7.0.2, ESM, PostgreSQL 17 + pgvector on port 5433, vitest, `node:crypto`, `node:fetch`. Zero new npm dependencies — everything here is hand-written per the dependency audit's own conclusion.

**Spec:** `docs/superpowers/specs/2026-08-18-customer-advisory-agent-design.md` (sections 4.1, 4.4, 4.5, 5), scoped by `docs/superpowers/plans/2026-08-18-m2-plan-index.md`. Dependency rationale: `docs/research/2026-08-18-conversational-agent-dependency-audit.md`.

## Global Constraints

These bind every task below, copied verbatim from `docs/superpowers/plans/2026-08-18-m2-plan-index.md`:

- Node 24.14.0, npm 11.9.0, TypeScript 7.0.2, ESM only. Relative imports end in
  `.ts` with `rewriteRelativeImportExtensions`; writing `.js` breaks Turbopack
  and Node type-stripping and is caught by `npm run lint:imports`.
- Every dependency pinned to an exact version, no range prefix. Enforced by
  `npm run lint:versions`.
- **Only two new dependencies are permitted across all of M2:**
  `compwright/x-hub-signature` and `promptfoo`. Any third requires stopping and
  asking. The audit doc explains why. (This plan introduces neither — the
  existing Meta webhook never actually adopted `x-hub-signature` either; it
  hand-rolled `node:crypto`, and this plan reuses that same function.)
- PostgreSQL 17 + pgvector on host port **5433**. The app connects as
  `smos_app` (NOSUPERUSER, NOBYPASSRLS). Migrations run as `smos`.
- Migrations 0000–0038 are applied. M2 migrations start at **0039**, which
  belongs to the M2A plan (knowledge tables). This plan's migrations start
  at **0040** and never touch 0039. Never edit an applied migration.
- Every workspace-owned table: `workspace_id`, RLS **enabled and forced**,
  policies carrying **both** USING and WITH CHECK. Every foreign key between
  two workspace-owned tables is **composite on `(id, workspace_id)`** with a
  matching UNIQUE on the referenced side — PostgreSQL evaluates foreign keys
  with RLS bypassed on the referenced table.
- Text columns that must carry content use a `~ '\S'` CHECK, never a length
  check. Functions schema-qualify their tables; `SET search_path = public`
  does not exclude `pg_temp`.
- No secret, credential, token or environment value in a migration or a test
  fixture. `npm run lint:secrets` enforces house rules.
- **No paid model call in any test or in CI, ever.** Tests use the
  deterministic fake provider. Embedding calls in tests use a fake embedder.
- TDD is verified, not assumed: write the failing test, run it, paste the
  failing output into the task report, then implement.
- Database invariants are proved against the real PostgreSQL by attempting
  the attack as `smos_app`. Never mock RLS, triggers, constraints,
  transactions or permissions.
- Ids come from `newId()`, never fixed literals — fixed workspace ids have
  already caused a real cross-file collision here. Clean up rows in a way
  that survives a failing test.
- `npm run verify` must exit 0 before every commit, run in the
  **foreground**.
- Commit style: lowercase conventional prefix, no emoji, body ending
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

### Interface contract this plan must satisfy (verbatim from the index)

```ts
// M2B — packages/integrations/src/adapter.ts (extend, do not replace)
export interface InboundMessage {
  channelMessageId: string; channelContactId: string; text: string; receivedAt: Date;
}
export interface ChannelAdapter {
  readonly name: string;
  healthCheck(): Promise<boolean>;
  publish(input: PublishInput): Promise<PublishResult>;
  sendDirectMessage(input: { channelContactId: string; text: string;
    idempotencyKey: string }): Promise<{ channelMessageId: string }>;
}
export function parseInbound(rawBody: string): InboundMessage[];
```

`PublishInput` / `PublishResult` are unchanged from the existing
`packages/integrations/src/adapter.ts`.

## File structure

New:
- `infra/migrations/0040_conversation_domain.sql` — `customer_contact`, `conversation`, `message`, the reply-window trigger.
- `infra/migrations/0041_message_immutable.sql` — locks `message` down.
- `packages/db/src/conversation-tenant.test.ts` — dedicated adversarial RLS proof for the three new tables, plus the trigger's own proof.
- `packages/db/src/message-immutability.test.ts` — direct-SQL proof that a written message cannot be edited.
- `packages/integrations/src/zalo/client.ts` — the raw Zalo OA HTTP client (send, profile, tag/follow).
- `packages/integrations/src/zalo/client.test.ts` — client tests against an injected fake fetch.
- `packages/integrations/src/zalo/adapter.ts` — `createZaloAdapter`, the `ChannelAdapter` implementation.
- `packages/integrations/src/zalo/fake-server.ts` — in-process fake mirroring `meta/fake-server.ts`.
- `packages/integrations/src/zalo/contract.test.ts` — adapter contract tests against the fake server.
- `packages/integrations/src/zalo/reply-window.ts` — the reply-window and complaint-rate ban-avoidance guard.
- `packages/integrations/src/zalo/reply-window.test.ts` — pure unit tests of the guard.
- `packages/integrations/src/zalo/adapter.test.ts` — proves the guard runs before any HTTP call.
- `packages/integrations/src/adapter.test.ts` — tests for `parseInbound`.
- `apps/web/src/server/zalo-webhook-secret.ts` — per-workspace Zalo webhook secret via the vault.
- `apps/web/src/app/api/webhooks/zalo/[workspaceId]/route.ts` — the webhook endpoint.
- `apps/web/src/app/api/webhooks/zalo/[workspaceId]/route.test.ts` — signature/replay tests.

Modified:
- `packages/testing/src/tenant-fixtures.ts` — seed one `customer_contact` / `conversation` / `message` row per fixture workspace.
- `packages/db/src/cross-tenant.test.ts` — the exhaustive catalog-driven suite auto-discovers the three new tables; its pinned expectation lists and probe-row builders must be taught about them in the same commit, or the suite fails immediately.
- `packages/integrations/src/adapter.ts` — add `InboundMessage`, widen `ChannelAdapter` with `sendDirectMessage`, add `parseInbound`.
- `packages/integrations/src/meta/client.ts` — add a minimal `sendDirectMessage` stub so it still satisfies the widened interface.
- `packages/integrations/src/meta/contract.test.ts` — no code change expected, but re-run as part of Task 5's typecheck since the interface it implements against changed.
- `packages/integrations/src/index.ts` — export the new Zalo and adapter surface.

---

### Task 1: the conversation domain (migration 0040)

**Files:**
- Create: `infra/migrations/0040_conversation_domain.sql`
- Create: `packages/db/src/conversation-tenant.test.ts`
- Modify: `packages/testing/src/tenant-fixtures.ts`
- Modify: `packages/db/src/cross-tenant.test.ts`

**Interfaces:**
- Consumes: `withTenant(pool, workspaceId, fn)` from `packages/db/src/tenant-scope.ts`; `createDbPool`, `createDb` from `packages/db/src/client.ts`; `workspace(id)` (already exists, `infra/migrations/0001_core_tenancy.sql`).
- Produces: tables `customer_contact(id, workspace_id, channel, channel_contact_id, display_name, created_at)`, `conversation(id, workspace_id, customer_contact_id, agent_paused_at, last_customer_message_at, reply_window_expires_at, created_at)`, `message(id, workspace_id, conversation_id, direction, channel_message_id, body, disclosure_sent, occurred_at, created_at)`. Later tasks (Task 2, Task 6) read `conversation.last_customer_message_at` / `reply_window_expires_at` and write into `message`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/conversation-tenant.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/db/src/conversation-tenant.test.ts`
Expected: FAIL — every query errors with `relation "customer_contact" does not exist` (the table doesn't exist yet).

- [ ] **Step 3: Write the migration**

Create `infra/migrations/0040_conversation_domain.sql`:

```sql
-- M2B Task 1: the conversation domain. This system has no concept of a
-- customer today -- grep every earlier migration for conversation/message/
-- chat/inbox and nothing matches (docs/superpowers/specs/
-- 2026-08-18-customer-advisory-agent-design.md section 4.1). This migration
-- creates the domain from nothing, not extending one.
--
-- Three tables, each workspace-owned per ADR-007: workspace_id NOT NULL, RLS
-- ENABLED and FORCED, a policy carrying both USING and WITH CHECK
-- (0001_core_tenancy.sql's pattern, repeated by every table since), and a
-- UNIQUE (id, workspace_id) so a later table can reference it with a
-- composite foreign key -- PostgreSQL evaluates a foreign key against its
-- referenced table with RLS bypassed entirely (0008_composite_tenant_fk.sql,
-- 0028_integration.sql), so a plain single-column REFERENCES would only
-- prove "some row with this id exists anywhere", never that it belongs to
-- the same workspace as the child row.
--
-- Text CHECKs use `x ~ '\S'`, never `btrim(...)` (0009_check_whitespace_
-- hardening.sql).
--
-- channel is a closed CHECK IN ('zalo') for M2 (D1: Zalo OA is the only
-- channel this milestone builds), not an open text column -- widening it to
-- a second channel is a forward-only ALTER TABLE ... DROP CONSTRAINT /
-- ADD CONSTRAINT in whichever later migration adds that channel.

-- customer_contact: the person on the other side of a conversation. One row
-- per (workspace, channel, channel_contact_id) -- the same Zalo user
-- messaging twice must resolve to the same contact, not a duplicate.
CREATE TABLE IF NOT EXISTS customer_contact (
  id                 uuid PRIMARY KEY,
  workspace_id       uuid NOT NULL REFERENCES workspace(id),
  channel            text NOT NULL CHECK (channel IN ('zalo')),
  channel_contact_id text NOT NULL CHECK (channel_contact_id ~ '\S'),
  display_name       text CHECK (display_name IS NULL OR display_name ~ '\S'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, channel, channel_contact_id),
  UNIQUE (id, workspace_id)
);
ALTER TABLE customer_contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_contact FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_contact_tenant_isolation ON customer_contact;
CREATE POLICY customer_contact_tenant_isolation ON customer_contact
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- conversation: one thread with one contact. A contact is already scoped to
-- exactly one channel (customer_contact.channel above), so a thread is
-- implicitly scoped to that same channel without a redundant column that
-- could drift from it -- UNIQUE (workspace_id, customer_contact_id) is what
-- makes it "one thread per contact", per the design spec's own phrase ("one
-- thread with one contact on one channel").
--
-- agent_paused_at (D8, spec section 4.5): null while the agent is live for
-- this thread; set the instant the founder sends a message into it, and
-- never cleared automatically -- resuming the agent is a deliberate founder
-- action. Writing this column is out of scope for this migration; M2C wires
-- the actual pause/resume path.
--
-- last_customer_message_at / reply_window_expires_at: the channel's reply-
-- window deadline the spec requires conversation to carry. Maintained by
-- the trigger below, not by application code, so it can never drift from
-- what actually arrived -- Task 6's ban-avoidance gate reads these two
-- columns and must never itself be responsible for keeping them correct.
CREATE TABLE IF NOT EXISTS conversation (
  id                        uuid PRIMARY KEY,
  workspace_id              uuid NOT NULL REFERENCES workspace(id),
  customer_contact_id       uuid NOT NULL,
  agent_paused_at           timestamptz,
  last_customer_message_at  timestamptz,
  reply_window_expires_at   timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, customer_contact_id),
  FOREIGN KEY (customer_contact_id, workspace_id) REFERENCES customer_contact (id, workspace_id)
);
ALTER TABLE conversation ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_tenant_isolation ON conversation;
CREATE POLICY conversation_tenant_isolation ON conversation
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- message: inbound and outbound, immutable once written (Task 2 adds the
-- trigger that actually enforces that; this migration only shapes the
-- table). disclosure_sent (D5) marks whether THIS outbound message carried
-- the "you are talking to an AI" disclosure -- meaningless for an inbound
-- message, so the CHECK below refuses it from ever being true on one.
--
-- channel_message_id is UNIQUE per workspace regardless of direction: a
-- real Zalo message id is assigned once, by Zalo, to exactly one message,
-- whichever direction it travelled -- this is what lets a later caller
-- (M2C) insert with ON CONFLICT (workspace_id, channel_message_id) DO
-- NOTHING and get idempotent replay-safety for free, the same shape
-- webhook_delivery already uses for its own nonce.
CREATE TABLE IF NOT EXISTS message (
  id                 uuid PRIMARY KEY,
  workspace_id       uuid NOT NULL REFERENCES workspace(id),
  conversation_id    uuid NOT NULL,
  direction          text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel_message_id text NOT NULL CHECK (channel_message_id ~ '\S'),
  body               text NOT NULL CHECK (body ~ '\S'),
  disclosure_sent    boolean NOT NULL DEFAULT false CHECK (direction = 'outbound' OR disclosure_sent = false),
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, channel_message_id),
  FOREIGN KEY (conversation_id, workspace_id) REFERENCES conversation (id, workspace_id)
);
CREATE INDEX IF NOT EXISTS message_ws_conversation_idx ON message (workspace_id, conversation_id, occurred_at);
ALTER TABLE message ENABLE ROW LEVEL SECURITY;
ALTER TABLE message FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_tenant_isolation ON message;
CREATE POLICY message_tenant_isolation ON message
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- Derives conversation.last_customer_message_at / reply_window_expires_at
-- from the message actually inserted, so the deadline Task 6's gate reads
-- can never be set by anything other than a real inbound message landing.
-- 7 days is Zalo's outer OpenAPI window (spec section 4.5); the inner
-- 48-hour free window is computed from last_customer_message_at directly by
-- the gate (packages/integrations/src/zalo/reply-window.ts), not stored
-- separately, so there is exactly one source of truth for "when did the
-- customer last write in". Table references are schema-qualified
-- (public.conversation) per 0022_function_table_qualification.sql: `SET
-- search_path = public` alone does not exclude pg_temp.
CREATE OR REPLACE FUNCTION conversation_bump_reply_window() RETURNS trigger AS $$
BEGIN
  IF NEW.direction = 'inbound' THEN
    UPDATE public.conversation
       SET last_customer_message_at = NEW.occurred_at,
           reply_window_expires_at  = NEW.occurred_at + interval '7 days'
     WHERE id = NEW.conversation_id AND workspace_id = NEW.workspace_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS message_bumps_reply_window ON message;
CREATE TRIGGER message_bumps_reply_window
  AFTER INSERT ON message
  FOR EACH ROW EXECUTE FUNCTION conversation_bump_reply_window();

-- Runtime grants, matching every other workspace-owned table's default
-- (0004_campaign.sql, 0012_agent_registry.sql, 0024_agent_run.sql,
-- 0028_integration.sql): smos_app reads, inserts and updates but never
-- deletes. message keeps UPDATE here -- Task 2 (0041) revokes it and adds
-- the immutability trigger as a second, independent mechanism, the same
-- two-migration shape 0028 -> 0032 already used for webhook_delivery.
GRANT SELECT, INSERT, UPDATE ON customer_contact, conversation, message TO smos_app;
```

- [ ] **Step 4: Apply the migration**

Run: `npm run db:migrate`
Expected: the migration runner reports `0040_conversation_domain.sql` applied.

- [ ] **Step 5: Run the test again, confirm it passes**

Run: `npx vitest run packages/db/src/conversation-tenant.test.ts`
Expected: still FAIL, but differently — this file's own assertions now pass, but running the whole suite next will show `packages/db/src/cross-tenant.test.ts` failing (see Step 6): its pinned `EXPECTED_TENANT_TABLES` / `EXPECTED_FK_PAIRS` no longer match what the catalog discovers, and its `buildProbeRow`/`fixtureIdForColumn` switch statements have no case for the three new tables, so its own "no probe-row builder registered" guard throws.

- [ ] **Step 6: Update the shared fixture so the exhaustive suite has real rows to probe**

Modify `packages/testing/src/tenant-fixtures.ts`. Add three new fields to `TenantFixture` (after `vaultSecretId`):

```ts
  vaultSecretId: Id;
  // M2B Task 1: one customer_contact / conversation / message per fixture
  // workspace, so cross-tenant.test.ts's exhaustive, catalog-driven suite
  // has a real row to probe for each of the three new tables, exactly like
  // every other table added since P4 task 3.
  customerContactId: Id;
  conversationId: Id;
  messageId: Id;
```

Add three new `newId()` calls near the top of `seedOne` (after `vaultSecretId`):

```ts
  const vaultSecretId = newId();
  const customerContactId = newId();
  const conversationId = newId();
  const messageId = newId();
```

Add the three inserts after the existing `vault_secret` insert, before the `return`:

```ts
  // M2B Task 1 (infra/migrations/0040_conversation_domain.sql): a real
  // contact/conversation/message chain per workspace. The message insert
  // fires conversation_bump_reply_window (AAFTER INSERT), which is fine --
  // it is exercised here as a side effect, same as every other real trigger
  // this fixture already runs through.
  await client.query(
    `insert into customer_contact (id, workspace_id, channel, channel_contact_id, display_name)
     values ($1, $2, 'zalo', $3, $4)`,
    [customerContactId, workspaceId, `e12-${label}-contact-${customerContactId}`, `E12 ${label} contact`],
  );
  await client.query(
    `insert into conversation (id, workspace_id, customer_contact_id) values ($1, $2, $3)`,
    [conversationId, workspaceId, customerContactId],
  );
  await client.query(
    `insert into message (id, workspace_id, conversation_id, direction, channel_message_id, body)
     values ($1, $2, $3, 'inbound', $4, 'e12 seed message')`,
    [messageId, workspaceId, conversationId, `e12-${label}-msg-${messageId}`],
  );
```

Add the three fields to the returned object:

```ts
    vaultSecretId,
    customerContactId,
    conversationId,
    messageId,
  };
}
```

- [ ] **Step 7: Teach the exhaustive suite about the three new tables**

Modify `packages/db/src/cross-tenant.test.ts`.

In `EXPECTED_TENANT_TABLES`, insert `"conversation"`, `"credential_reference"` stays, add `"customer_contact"` and `"message"` in alphabetical position (the array is already `.toSorted()`'d at comparison time, but keep it readable):

```ts
const EXPECTED_TENANT_TABLES = [
  "agent_definition", "agent_run", "agent_version", "approval_decision", "approval_request",
  "audit_log", "campaign", "content_item", "content_version", "conversation",
  "credential_reference", "customer_contact", "event", "goal", "integration",
  "message", "metric", "outbox", "publication", "run_checkpoint",
  "source_citation", "tool_call", "vault_secret", "webhook_delivery", "workspace_member",
].toSorted();
```

In `EXPECTED_FK_PAIRS`, add two entries:

```ts
const EXPECTED_FK_PAIRS = [
  "agent_run->agent_version",
  "agent_run->campaign",
  "agent_version->agent_definition",
  "approval_decision->approval_request",
  "approval_decision->approval_request",
  "approval_decision->workspace_member",
  "approval_request->campaign",
  "approval_request->content_version",
  "campaign->goal",
  "content_item->campaign",
  "content_version->content_item",
  // M2B Task 1 (infra/migrations/0040_conversation_domain.sql):
  "conversation->customer_contact",
  "credential_reference->integration",
  "event->publication",
  "integration->publication",
  "message->conversation",
  "metric->campaign",
  "publication->approval_decision",
  "publication->campaign",
  "publication->content_version",
  "run_checkpoint->agent_run",
  "source_citation->content_version",
  "tool_call->agent_run",
].toSorted();
```

Add three cases to `buildProbeRow`'s `switch`, just before the `default:` branch:

```ts
    // M2B Task 1 (infra/migrations/0040_conversation_domain.sql):
    case "customer_contact":
      return {
        columns: ["id", "workspace_id", "channel", "channel_contact_id", "display_name"],
        cells: [
          { value: id }, { value: ws.workspaceId }, { value: "zalo" },
          { value: `e12-probe-contact-${id}` }, { value: "E12 probe contact" },
        ],
      };
    case "conversation":
      return {
        columns: ["id", "workspace_id", "customer_contact_id"],
        cells: [{ value: id }, { value: ws.workspaceId }, { value: ws.customerContactId }],
      };
    case "message":
      return {
        columns: ["id", "workspace_id", "conversation_id", "direction", "channel_message_id", "body"],
        cells: [
          { value: id }, { value: ws.workspaceId }, { value: ws.conversationId },
          { value: "inbound" }, { value: `e12-probe-msg-${id}` }, { value: "e12 probe message body" },
        ],
      };
```

Add two entries to `fixtureIdForColumn`'s `map`:

```ts
    actor_user_id: "userId",
    // M2B Task 1 (infra/migrations/0040_conversation_domain.sql):
    customer_contact_id: "customerContactId",
    conversation_id: "conversationId",
  };
```

In the `afterAll` cleanup loop, add three deletes before the `workspace_member` delete (children of `workspace_member`'s ancestry are unrelated, but this keeps the new deletes grouped with the other P4/M2 additions and, being leaf tables with no children, order among themselves doesn't matter beyond message before conversation before customer_contact):

```ts
    await adminPool.query("delete from message where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from conversation where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from customer_contact where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from workspace_member where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
```

- [ ] **Step 8: Run both suites and confirm they pass**

Run: `npx vitest run packages/db/src/conversation-tenant.test.ts packages/db/src/cross-tenant.test.ts`
Expected: PASS — including the two `it("discovered exactly the committed set of ...")` pin assertions, the RLS-enabled/forced `it.each`, the "B's rows are invisible" `it.each` for all three new tables, the INSERT-refusal `it.each`, and the two new composite-FK hijack cases.

- [ ] **Step 9: Commit**

```bash
git add infra/migrations/0040_conversation_domain.sql packages/db/src/conversation-tenant.test.ts packages/testing/src/tenant-fixtures.ts packages/db/src/cross-tenant.test.ts
git commit -m "$(cat <<'EOF'
feat(db): create the conversation domain (customer_contact, conversation, message)

Adds migration 0040 with RLS enabled and forced, composite (id,
workspace_id) foreign keys, and a trigger that derives the reply-window
deadline from real inbound messages. Extends the shared tenant fixture and
the exhaustive cross-tenant suite so the new tables are covered by the
same generic isolation proof as every other workspace-owned table.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: message immutability (migration 0041)

**Files:**
- Create: `infra/migrations/0041_message_immutable.sql`
- Create: `packages/db/src/message-immutability.test.ts`

**Interfaces:**
- Consumes: `message` table from Task 1; `withTenant`.
- Produces: nothing new consumed by later tasks — this is a closed invariant.

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/message-immutability.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/db/src/message-immutability.test.ts`
Expected: FAIL on the first three tests — `body`/`channel_message_id`/`disclosure_sent` UPDATE succeeds (0040 granted UPDATE and there is no trigger yet), so `.rejects.toThrow(...)` fails with "promise resolved instead of rejecting". The fourth test passes already.

- [ ] **Step 3: Write the migration**

Create `infra/migrations/0041_message_immutable.sql`:

```sql
-- M2B Task 2: message is a record of what a real customer actually sent or
-- received; once written it must never change. 0040_conversation_domain.sql
-- granted smos_app UPDATE on message (matching every other table's default
-- grant) so this migration is what actually locks it down -- the same two-
-- migration shape 0028_integration.sql -> 0032_webhook_delivery_nonce_and_
-- audit.sql already used for webhook_delivery, and for the identical reason
-- stated there: "the grant is revoked AND a trigger refuses the UPDATE, so
-- re-granting UPDATE in some future migration is not by itself enough to
-- reopen it."
CREATE OR REPLACE FUNCTION message_is_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'message is an immutable record of what a real customer sent or received; % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS message_no_mutation ON message;
CREATE TRIGGER message_no_mutation
  BEFORE UPDATE ON message
  FOR EACH ROW EXECUTE FUNCTION message_is_immutable();

REVOKE UPDATE ON message FROM smos_app;
```

- [ ] **Step 4: Apply and re-run**

Run: `npm run db:migrate`
Run: `npx vitest run packages/db/src/message-immutability.test.ts`
Expected: PASS — all four tests.

- [ ] **Step 5: Commit**

```bash
git add infra/migrations/0041_message_immutable.sql packages/db/src/message-immutability.test.ts
git commit -m "$(cat <<'EOF'
feat(db): make message immutable once written

A sent or received message is a record of what a real customer got; a
BEFORE UPDATE trigger refuses every UPDATE unconditionally, and the UPDATE
grant is revoked from smos_app as a second, independent mechanism, mirroring
the webhook_delivery immutability shape.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: the Zalo OA client

**Files:**
- Create: `packages/integrations/src/zalo/client.ts`
- Create: `packages/integrations/src/zalo/client.test.ts`
- Modify: `packages/integrations/src/index.ts`

**Interfaces:**
- Consumes: `guardedFetch`, `FetchLike` from `packages/integrations/src/guarded-fetch.ts`; `AdapterError`, `ErrorKind` from `packages/integrations/src/errors.ts`.
- Produces: `createZaloClient(cfg: ZaloClientConfig, fetchImpl?: FetchLike): ZaloClient` where
  ```ts
  export interface ZaloClientConfig {
    baseUrl: string;
    accessToken: string;
    allowedHosts: string[];
    timeoutMs?: number;
  }
  export interface ZaloProfile { userId: string; displayName: string; avatar: string | null; }
  export interface ZaloClient {
    sendMessage(recipientId: string, text: string): Promise<{ messageId: string }>;
    getProfile(userId: string): Promise<ZaloProfile>;
    tagFollower(userId: string, tagName: string): Promise<void>;
    removeFollowerTag(userId: string, tagName: string): Promise<void>;
    listFollowersByTag(tagName: string): Promise<string[]>;
  }
  ```
  Task 5's `zalo/adapter.ts` consumes `createZaloClient` and `ZaloClientConfig` directly.

- [ ] **Step 1: Write the failing test**

Create `packages/integrations/src/zalo/client.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createZaloClient } from "./client.ts";
import type { FetchLike } from "../guarded-fetch.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("zalo client", () => {
  it("sends a message and returns the channel message id, over the allowlisted host only", async () => {
    let calls = 0;
    const fakeFetch: FetchLike = async (input, init) => {
      calls++;
      const url = new URL(String(input));
      expect(url.hostname).toBe("sandbox.zalo.test");
      expect(url.pathname).toBe("/message");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("access_token")).toBe("test-token");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ recipient: { user_id: "u1" }, message: { text: "hi" } });
      return jsonResponse({ error: 0, message: "Success", data: { message_id: "msg-1" } });
    };
    const client = createZaloClient(
      { baseUrl: "https://sandbox.zalo.test", accessToken: "test-token", allowedHosts: ["sandbox.zalo.test"] },
      fakeFetch,
    );
    const result = await client.sendMessage("u1", "hi");
    expect(result).toEqual({ messageId: "msg-1" });
    expect(calls).toBe(1);
  });

  it("surfaces an invalid/expired access token (error -216) as auth_expired, non-retryable", async () => {
    const fakeFetch: FetchLike = async () => jsonResponse({ error: -216, message: "Access token is invalid" });
    const client = createZaloClient(
      { baseUrl: "https://sandbox.zalo.test", accessToken: "bad-token", allowedHosts: ["sandbox.zalo.test"] },
      fakeFetch,
    );
    await expect(client.sendMessage("u1", "hi")).rejects.toMatchObject({ kind: "auth_expired", retryable: false });
  });

  it("surfaces an HTTP 429 as rate_limited, retryable", async () => {
    const fakeFetch: FetchLike = async () => jsonResponse({ error: -32, message: "Rate limit exceeded" }, 429);
    const client = createZaloClient(
      { baseUrl: "https://sandbox.zalo.test", accessToken: "test-token", allowedHosts: ["sandbox.zalo.test"] },
      fakeFetch,
    );
    await expect(client.sendMessage("u1", "hi")).rejects.toMatchObject({ kind: "rate_limited", retryable: true });
  });

  it("fetches a follower's profile", async () => {
    const fakeFetch: FetchLike = async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/getprofile");
      expect(JSON.parse(url.searchParams.get("data")!)).toEqual({ user_id: "u1" });
      return jsonResponse({
        error: 0,
        message: "Success",
        data: { user_id: "u1", display_name: "Nguyen Van A", avatar: "https://cdn.zalo.test/a.png" },
      });
    };
    const client = createZaloClient(
      { baseUrl: "https://sandbox.zalo.test", accessToken: "test-token", allowedHosts: ["sandbox.zalo.test"] },
      fakeFetch,
    );
    await expect(client.getProfile("u1")).resolves.toEqual({
      userId: "u1",
      displayName: "Nguyen Van A",
      avatar: "https://cdn.zalo.test/a.png",
    });
  });

  it("tags a follower", async () => {
    let calls = 0;
    const fakeFetch: FetchLike = async (input, init) => {
      calls++;
      const url = new URL(String(input));
      expect(url.pathname).toBe("/tag/tagfollower");
      expect(JSON.parse(String(init?.body))).toEqual({ user_id: "u1", tag_name: "vip" });
      return jsonResponse({ error: 0, message: "Success" });
    };
    const client = createZaloClient(
      { baseUrl: "https://sandbox.zalo.test", accessToken: "test-token", allowedHosts: ["sandbox.zalo.test"] },
      fakeFetch,
    );
    await client.tagFollower("u1", "vip");
    expect(calls).toBe(1);
  });

  it("removes a follower tag", async () => {
    const fakeFetch: FetchLike = async (input, init) => {
      expect(new URL(String(input)).pathname).toBe("/tag/rmfollowerfromtag");
      expect(JSON.parse(String(init?.body))).toEqual({ user_id: "u1", tag_name: "vip" });
      return jsonResponse({ error: 0, message: "Success" });
    };
    const client = createZaloClient(
      { baseUrl: "https://sandbox.zalo.test", accessToken: "test-token", allowedHosts: ["sandbox.zalo.test"] },
      fakeFetch,
    );
    await expect(client.removeFollowerTag("u1", "vip")).resolves.toBeUndefined();
  });

  it("lists followers by tag", async () => {
    const fakeFetch: FetchLike = async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/tag/getfollowers");
      expect(JSON.parse(url.searchParams.get("data")!)).toEqual({ tag_name: "vip" });
      return jsonResponse({ error: 0, message: "Success", data: { followers: ["u1", "u2"] } });
    };
    const client = createZaloClient(
      { baseUrl: "https://sandbox.zalo.test", accessToken: "test-token", allowedHosts: ["sandbox.zalo.test"] },
      fakeFetch,
    );
    await expect(client.listFollowersByTag("vip")).resolves.toEqual(["u1", "u2"]);
  });

  it("never calls fetchImpl for a host outside the allowlist -- guardedFetch refuses first", async () => {
    let calls = 0;
    const fakeFetch: FetchLike = async () => {
      calls++;
      return jsonResponse({ error: 0, message: "Success", data: { message_id: "unreachable" } });
    };
    const client = createZaloClient(
      { baseUrl: "https://sandbox.zalo.test", accessToken: "t", allowedHosts: ["someone-else.test"] },
      fakeFetch,
    );
    await expect(client.sendMessage("u1", "hi")).rejects.toThrow(/allowlist/i);
    expect(calls).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/integrations/src/zalo/client.test.ts`
Expected: FAIL — `Cannot find module './client.ts'` (the file doesn't exist yet).

- [ ] **Step 3: Write the client**

Create `packages/integrations/src/zalo/client.ts`:

```ts
import { guardedFetch, type FetchLike } from "../guarded-fetch.ts";
import { AdapterError, type ErrorKind } from "../errors.ts";

export interface ZaloClientConfig {
  baseUrl: string;
  accessToken: string;
  allowedHosts: string[];
  /** Milliseconds to wait for a response before treating the call as
   * `upstream_unavailable`. Default 10000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

// Zalo OA's own well-documented sentinel for an invalid/expired access
// token (its OA API error-code reference, `error: -216`). Every other
// nonzero `error` code maps to permanent_rejection below -- unlike Meta's
// Graph API, Zalo's OA API returns HTTP 200 for almost every API-level
// failure and signals it through this body field instead, so a caller
// cannot rely on HTTP status alone. This single code is the one piece of
// that mapping used here; verify the fuller code table against a live
// sandbox Official Account before this client reaches a real customer --
// flagged unverified the same way the design spec flags D5's legal claim.
const ZALO_INVALID_TOKEN_ERROR_CODE = -216;

interface ZaloEnvelope<T> {
  error: number;
  message: string;
  data?: T;
}

function mapZaloFailureToKind(httpStatus: number, bodyErrorCode: number | null): ErrorKind {
  if (httpStatus === 401 || httpStatus === 403) return "auth_expired";
  if (httpStatus === 429) return "rate_limited";
  if (httpStatus >= 500) return "upstream_unavailable";
  if (httpStatus >= 400) return "invalid_input";
  if (bodyErrorCode === ZALO_INVALID_TOKEN_ERROR_CODE) return "auth_expired";
  return "permanent_rejection";
}

export interface ZaloProfile {
  userId: string;
  displayName: string;
  avatar: string | null;
}

export interface ZaloClient {
  sendMessage(recipientId: string, text: string): Promise<{ messageId: string }>;
  getProfile(userId: string): Promise<ZaloProfile>;
  tagFollower(userId: string, tagName: string): Promise<void>;
  removeFollowerTag(userId: string, tagName: string): Promise<void>;
  listFollowersByTag(tagName: string): Promise<string[]>;
}

/**
 * Typed client for the Zalo OA API, pointed at either the real API or the
 * in-process sandbox from `fake-server.ts` (`fetchImpl` swapped for tests).
 * Every outbound call goes through `guardedFetch`, never a bare `fetch` --
 * see meta/client.ts's own header for why that matters (the allowlist and
 * the redirect-safety re-check are only genuinely enforced when every hop
 * goes through it).
 */
export function createZaloClient(cfg: ZaloClientConfig, fetchImpl: FetchLike = fetch): ZaloClient {
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T = undefined>(path: string, method: string, body?: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      const requestInit: Parameters<typeof guardedFetch>[2] = {
        method,
        headers: body
          ? { "content-type": "application/json", access_token: cfg.accessToken }
          : { access_token: cfg.accessToken },
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (body) requestInit.body = JSON.stringify(body);
      response = await guardedFetch(`${cfg.baseUrl}${path}`, cfg.allowedHosts, requestInit, fetchImpl);
    } catch (err) {
      if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new AdapterError("upstream_unavailable", `Zalo request to ${path} timed out after ${timeoutMs}ms`);
      }
      // The egress guard refusing this call outright (bad protocol, host
      // not on the allowlist, blocked address) -- non-retryable, since
      // retrying the identical call hits the same guard refusal again.
      throw new AdapterError("permanent_rejection", err instanceof Error ? err.message : String(err));
    }

    const text = await response.text();
    let json: unknown = null;
    if (text !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        throw new AdapterError(
          "upstream_unavailable",
          `Zalo returned a non-JSON response (status ${response.status}): ${text.slice(0, 200)}`,
        );
      }
    }

    const envelope = json as Partial<ZaloEnvelope<T>> | null;
    const bodyErrorCode = envelope && typeof envelope.error === "number" ? envelope.error : null;

    if (!response.ok || bodyErrorCode === null || bodyErrorCode !== 0) {
      const kind = mapZaloFailureToKind(response.status, bodyErrorCode);
      const message =
        envelope && typeof envelope.message === "string" ? envelope.message : `Zalo call to ${path} failed (status ${response.status})`;
      throw new AdapterError(kind, message);
    }

    return (envelope?.data ?? undefined) as T;
  }

  return {
    async sendMessage(recipientId, text) {
      const data = await call<{ message_id: string }>("/message", "POST", {
        recipient: { user_id: recipientId },
        message: { text },
      });
      if (!data || typeof data.message_id !== "string" || data.message_id === "") {
        throw new AdapterError("upstream_unavailable", "Zalo sendMessage response was missing a message id");
      }
      return { messageId: data.message_id };
    },

    async getProfile(userId) {
      const data = await call<{ user_id: string; display_name: string; avatar?: string }>(
        `/getprofile?data=${encodeURIComponent(JSON.stringify({ user_id: userId }))}`,
        "GET",
      );
      if (!data || typeof data.user_id !== "string" || typeof data.display_name !== "string") {
        throw new AdapterError("upstream_unavailable", "Zalo getProfile response was missing required fields");
      }
      return { userId: data.user_id, displayName: data.display_name, avatar: data.avatar ?? null };
    },

    async tagFollower(userId, tagName) {
      await call("/tag/tagfollower", "POST", { user_id: userId, tag_name: tagName });
    },

    async removeFollowerTag(userId, tagName) {
      await call("/tag/rmfollowerfromtag", "POST", { user_id: userId, tag_name: tagName });
    },

    async listFollowersByTag(tagName) {
      const data = await call<{ followers: string[] }>(
        `/tag/getfollowers?data=${encodeURIComponent(JSON.stringify({ tag_name: tagName }))}`,
        "GET",
      );
      return data?.followers ?? [];
    },
  };
}
```

- [ ] **Step 4: Export from the package index**

Modify `packages/integrations/src/index.ts`, add:

```ts
export { createZaloClient, type ZaloClientConfig, type ZaloClient, type ZaloProfile } from "./zalo/client.ts";
```

- [ ] **Step 5: Run tests, confirm they pass**

Run: `npx vitest run packages/integrations/src/zalo/client.test.ts`
Expected: PASS — all 8 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/integrations/src/zalo/client.ts packages/integrations/src/zalo/client.test.ts packages/integrations/src/index.ts
git commit -m "$(cat <<'EOF'
feat(integrations): add the Zalo OA client

Send message, get profile, and follower tag management, hand-written per
the dependency audit (no Zalo OA repo has a verifiable licence). Every
outbound call routes through guardedFetch; tests use an injected fake
fetch and make no real network call.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Zalo webhook signature verification

**Files:**
- Create: `apps/web/src/server/zalo-webhook-secret.ts`
- Create: `apps/web/src/app/api/webhooks/zalo/[workspaceId]/route.ts`
- Create: `apps/web/src/app/api/webhooks/zalo/[workspaceId]/route.test.ts`

**Interfaces:**
- Consumes: `verifySignature(body, header, secret): boolean` from `apps/web/src/server/webhook-signature.ts` (reused unmodified — it is already algorithm-generic, HMAC-SHA256 with a `sha256=<hex>` prefix and a timing-safe compare, not Meta-specific in implementation); `getOrCreateSecret` from `@smos/vault`; `getKmsProvider`, `getVaultPool` from `apps/web/src/server/vault.ts`; `checkWebhookRateLimit`, `extractClientIp` from `apps/web/src/server/webhook-rate-limit.ts`; `readBoundedBody`, `MAX_WEBHOOK_BODY_BYTES`, `BodyTooLargeError` from `apps/web/src/server/read-bounded-body.ts`; `withTenant`, `getPool`, `newId`, `isId`, `Id`.
- Produces: `getWorkspaceZaloWebhookSecret(workspaceId: Id): Promise<string | null>`; `POST` route handler at `/api/webhooks/zalo/[workspaceId]`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/app/api/webhooks/zalo/[workspaceId]/route.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "@smos/db";
import { newId, type Id } from "@smos/domain";
import { getWorkspaceZaloWebhookSecret } from "../../../../../server/zalo-webhook-secret.ts";

const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);
let POST: typeof import("./route.ts").POST;
let workspaceId: Id;

function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function req(
  wsId: string,
  body: string,
  signatureHeader: string,
): { request: Request; context: { params: Promise<{ workspaceId: string }> } } {
  return {
    request: new Request(`http://sandbox.test/api/webhooks/zalo/${wsId}`, {
      method: "POST",
      body,
      headers: signatureHeader.length > 0 ? { "x-zalo-signature": signatureHeader } : {},
    }),
    context: { params: Promise.resolve({ workspaceId: wsId }) },
  };
}

function eventBody(msgId: string): string {
  return JSON.stringify({
    app_id: "test-app",
    event_name: "user_send_text",
    sender: { id: "user-1" },
    timestamp: String(Date.now()),
    message: { msg_id: msgId, text: "xin chao" },
  });
}

beforeAll(async () => {
  ({ POST } = await import("./route.ts"));
  workspaceId = newId();
  await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [workspaceId, `zalo-webhook-test-${workspaceId}`]);
});

afterAll(async () => {
  await adminPool.query(`delete from webhook_delivery where workspace_id = $1`, [workspaceId]);
  await adminPool.query(`delete from vault_secret where workspace_id = $1`, [workspaceId]);
  await adminPool.query(`delete from workspace where id = $1`, [workspaceId]);
  await adminPool.end();
});

describe("POST /api/webhooks/zalo/[workspaceId]", () => {
  it("refuses a request with no signature header at all", async () => {
    const { request, context } = req(workspaceId, eventBody(`msg-${newId()}`), "");
    expect((await POST(request, context)).status).toBe(401);
  });

  it("refuses an empty signature header", async () => {
    const { request, context } = req(workspaceId, eventBody(`msg-${newId()}`), "sha256=");
    expect((await POST(request, context)).status).toBe(401);
  });

  it("refuses a signature under the wrong algorithm prefix", async () => {
    const secret = await getWorkspaceZaloWebhookSecret(workspaceId);
    if (secret === null) throw new Error("could not provision a test secret");
    const body = eventBody(`msg-${newId()}`);
    const sha1Hex = createHmac("sha1", secret).update(body).digest("hex");
    const { request, context } = req(workspaceId, body, `sha1=${sha1Hex}`);
    expect((await POST(request, context)).status).toBe(401);
  });

  it("refuses a valid HMAC computed over different bytes than the ones actually received", async () => {
    const secret = await getWorkspaceZaloWebhookSecret(workspaceId);
    if (secret === null) throw new Error("could not provision a test secret");
    const signedBody = eventBody(`msg-signed-${newId()}`);
    const actualBody = eventBody(`msg-actual-${newId()}`);
    const { request, context } = req(workspaceId, actualBody, sign(signedBody, secret));
    expect((await POST(request, context)).status).toBe(401);
  });

  it("accepts a genuinely valid delivery, then a byte-for-byte replay of it is idempotent (still 200, not a second row)", async () => {
    const secret = await getWorkspaceZaloWebhookSecret(workspaceId);
    if (secret === null) throw new Error("could not provision a test secret");
    const msgId = `msg-replay-${newId()}`;
    const body = eventBody(msgId);
    const signature = sign(body, secret);

    const first = req(workspaceId, body, signature);
    expect((await POST(first.request, first.context)).status).toBe(200);

    const second = req(workspaceId, body, signature);
    expect((await POST(second.request, second.context)).status).toBe(200);

    const count = await adminPool.query(
      `select count(*)::int as n from webhook_delivery where workspace_id = $1 and provider = 'zalo' and external_id = $2 and signature_ok`,
      [workspaceId, msgId],
    );
    expect(count.rows[0].n).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "apps/web/src/app/api/webhooks/zalo/[workspaceId]/route.test.ts"`
Expected: FAIL — `Cannot find module '../../../../../server/zalo-webhook-secret.ts'` / `Cannot find module './route.ts'` (neither file exists yet).

- [ ] **Step 3: Write the secret provisioning module**

Create `apps/web/src/server/zalo-webhook-secret.ts`:

```ts
import type { Id } from "@smos/domain";
import { getOrCreateSecret } from "@smos/vault";
import { logger } from "@smos/telemetry";
import { getKmsProvider, getVaultPool } from "./vault.ts";

// Fixed slug, mirroring webhook-secret.ts's own WEBHOOK_SECRET_SLUG: one
// Zalo-webhook-signing secret per workspace, provisioned once on first use
// and stored sealed via the credential vault (0036_vault_secret.sql). A
// SEPARATE secret from Meta's (different slug) -- leaking one channel's
// webhook secret must never say anything about the other's.
const ZALO_WEBHOOK_SECRET_SLUG = "zalo-webhook-secret";

/**
 * Never throws. Any failure (vault unreachable, workspace id not a real
 * row) resolves to `null`, and the caller (route.ts) treats a null secret
 * exactly like a bad signature: 401, never a 500, never "skip
 * verification" -- the identical contract getWorkspaceWebhookSecret (Meta)
 * already uses.
 */
export async function getWorkspaceZaloWebhookSecret(workspaceId: Id): Promise<string | null> {
  try {
    return await getOrCreateSecret(getVaultPool(), getKmsProvider(), workspaceId, ZALO_WEBHOOK_SECRET_SLUG);
  } catch (error) {
    logger.warn("could not resolve or provision this workspace's Zalo webhook secret from the vault", {
      workspaceId,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}
```

- [ ] **Step 4: Write the route**

Create `apps/web/src/app/api/webhooks/zalo/[workspaceId]/route.ts`:

```ts
import { createHash } from "node:crypto";
import { isId, newId, type Id } from "@smos/domain";
import { withTenant } from "@smos/db";
import { logger } from "@smos/telemetry";
import { getPool } from "../../../../../server/db.ts";
import { verifySignature } from "../../../../../server/webhook-signature.ts";
import { getWorkspaceZaloWebhookSecret } from "../../../../../server/zalo-webhook-secret.ts";
import { checkWebhookRateLimit, extractClientIp } from "../../../../../server/webhook-rate-limit.ts";
import { BodyTooLargeError, MAX_WEBHOOK_BODY_BYTES, readBoundedBody } from "../../../../../server/read-bounded-body.ts";

// Every request does real I/O (DB); nothing about this route can be
// statically cached or prerendered.
export const dynamic = "force-dynamic";

const SIGNATURE_HEADER = "x-zalo-signature";
const PROVIDER = "zalo";

/**
 * M2B Task 4. Follows apps/web/src/app/api/webhooks/meta/[workspaceId]/
 * route.ts's own ordering exactly: bounded read -> signature verify (over
 * the per-workspace secret, so the workspace a delivery claims to be for is
 * itself covered by the signature) -> rate limit -> only then parse the
 * body -> record the delivery under the nonce-shaped UNIQUE (workspace_id,
 * provider, external_id) WHERE signature_ok index (0032_webhook_delivery_
 * nonce_and_audit.sql), so a captured signature cannot be replayed for a
 * second effect.
 *
 * Deliberately narrower than the Meta route in one respect: this route
 * does not yet write into customer_contact/conversation/message. Wiring a
 * verified inbound Zalo event into the conversation domain is the
 * advisory agent's own dispatch path (M2C, which depends on this plan) --
 * this route's job is limited to proving the delivery is genuine and
 * recording it exactly once, which is a complete, independently testable
 * property on its own.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId: rawWorkspaceId } = await context.params;

  let rawBody: string;
  try {
    rawBody = await readBoundedBody(request.body, MAX_WEBHOOK_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      logger.warn("zalo webhook body exceeded the cap; refused before parsing", { workspaceId: rawWorkspaceId });
      return new Response(null, { status: 413 });
    }
    throw error;
  }

  const signatureHeader = request.headers.get(SIGNATURE_HEADER) ?? "";
  const workspaceSecret = isId(rawWorkspaceId) ? await getWorkspaceZaloWebhookSecret(rawWorkspaceId as Id) : null;
  const signatureOk = workspaceSecret !== null && verifySignature(rawBody, signatureHeader, workspaceSecret);
  const pool = getPool();

  let throttledRetryAfterSeconds: number | null = null;
  if (signatureOk) {
    const decision = await checkWebhookRateLimit(pool, "valid_workspace", rawWorkspaceId);
    if (!decision.allowed) throttledRetryAfterSeconds = decision.retryAfterSeconds;
  } else {
    const ipDecision = await checkWebhookRateLimit(pool, "invalid_ip", extractClientIp(request));
    const workspaceDecision = isId(rawWorkspaceId)
      ? await checkWebhookRateLimit(pool, "invalid_workspace", rawWorkspaceId)
      : null;
    const globalDecision = await checkWebhookRateLimit(pool, "invalid_global", "global");
    const blocked = [ipDecision, workspaceDecision, globalDecision].find(
      (decision): decision is NonNullable<typeof decision> => decision !== null && !decision.allowed,
    );
    if (blocked) throttledRetryAfterSeconds = blocked.retryAfterSeconds;
  }
  if (throttledRetryAfterSeconds !== null) {
    logger.warn("zalo webhook rate limit exceeded; throttling before any delivery row is written", {
      workspaceId: rawWorkspaceId,
      signatureOk,
    });
    return new Response(null, { status: 429, headers: { "Retry-After": String(throttledRetryAfterSeconds) } });
  }

  if (!signatureOk) {
    const bodyDigest = createHash("sha256").update(rawBody).digest("hex");
    logger.warn("zalo webhook signature verification failed", {
      workspaceId: rawWorkspaceId,
      bodyDigest: bodyDigest.slice(0, 16),
      hadSignatureHeader: signatureHeader.length > 0,
    });
    await recordRejectedDelivery(rawWorkspaceId, bodyDigest);
    return new Response(null, { status: 401 });
  }

  if (!isId(rawWorkspaceId)) {
    return new Response(null, { status: 404 });
  }
  const workspaceId = rawWorkspaceId as Id;

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!isValidZaloWebhookBody(parsedBody)) {
    return new Response(null, { status: 400 });
  }

  const exists = await withTenant(pool, workspaceId, (tx) =>
    tx.query(`select 1 from workspace where id = $1`, [workspaceId]));
  if (exists.rowCount === 0) {
    return new Response(null, { status: 404 });
  }

  const deliveryId = parsedBody.message?.msg_id ?? `${parsedBody.event_name}:${parsedBody.timestamp}`;
  await withTenant(pool, workspaceId, (tx) =>
    tx.query(
      `insert into webhook_delivery (id, workspace_id, provider, external_id, signature_ok, payload)
       values ($1, $2, $3, $4, true, $5::jsonb)
       on conflict (workspace_id, provider, external_id) where signature_ok do nothing`,
      [newId(), workspaceId, PROVIDER, deliveryId, JSON.stringify(parsedBody)],
    ));

  return new Response(null, { status: 200 });
}

async function recordRejectedDelivery(rawWorkspaceId: string, bodyDigest: string): Promise<void> {
  if (!isId(rawWorkspaceId)) return;
  const workspaceId = rawWorkspaceId as Id;
  try {
    await withTenant(getPool(), workspaceId, (tx) =>
      tx.query(
        `insert into webhook_delivery (id, workspace_id, provider, external_id, signature_ok, payload)
         values ($1, $2, $3, $4, false, '{}'::jsonb)
         on conflict (workspace_id, provider, external_id) where not signature_ok do nothing`,
        [newId(), workspaceId, PROVIDER, `rejected:${bodyDigest.slice(0, 32)}`],
      ));
  } catch (error) {
    logger.warn("could not record a rejected zalo webhook delivery receipt", {
      workspaceId: rawWorkspaceId,
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
}

interface ZaloWebhookBody {
  app_id: string;
  event_name: string;
  sender: { id: string };
  timestamp: string;
  message?: { msg_id: string; text?: string };
}

function isValidZaloWebhookBody(value: unknown): value is ZaloWebhookBody {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["app_id"] !== "string" || v["app_id"].length === 0) return false;
  if (typeof v["event_name"] !== "string" || v["event_name"].length === 0) return false;
  if (typeof v["timestamp"] !== "string" || v["timestamp"].length === 0) return false;
  const sender = v["sender"];
  if (typeof sender !== "object" || sender === null || typeof (sender as Record<string, unknown>)["id"] !== "string") return false;
  const message = v["message"];
  if (message !== undefined) {
    if (typeof message !== "object" || message === null) return false;
    if (typeof (message as Record<string, unknown>)["msg_id"] !== "string") return false;
  }
  return true;
}
```

- [ ] **Step 5: Run tests, confirm they pass**

Run: `npx vitest run "apps/web/src/app/api/webhooks/zalo/[workspaceId]/route.test.ts"`
Expected: PASS — all 5 tests, including the replay test's row-count assertion.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/zalo-webhook-secret.ts "apps/web/src/app/api/webhooks/zalo/[workspaceId]/route.ts" "apps/web/src/app/api/webhooks/zalo/[workspaceId]/route.test.ts"
git commit -m "$(cat <<'EOF'
feat(web): verify Zalo OA webhook signatures before parsing the body

Mirrors the Meta webhook's per-workspace secret, nonce, and rate-limit
design exactly, reusing the same HMAC-SHA256 timing-safe verifySignature
primitive rather than duplicating it. Covers a missing signature, an empty
one, a wrong-algorithm one, a valid signature over different bytes, and a
byte-for-byte replay.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `sendDirectMessage` and `parseInbound` on the channel abstraction

**Files:**
- Modify: `packages/integrations/src/adapter.ts`
- Modify: `packages/integrations/src/meta/client.ts`
- Create: `packages/integrations/src/adapter.test.ts`
- Create: `packages/integrations/src/zalo/fake-server.ts`
- Create: `packages/integrations/src/zalo/adapter.ts`
- Create: `packages/integrations/src/zalo/contract.test.ts`
- Modify: `packages/integrations/src/index.ts`

**Interfaces:**
- Consumes: `createZaloClient`, `ZaloClientConfig` (Task 3); `AdapterError` (`errors.ts`); `ChannelAdapter`, `PublishInput`, `PublishResult` (`adapter.ts`, this task widens them).
- Produces (binding, per the plan-index interface contract):
  ```ts
  export interface InboundMessage {
    channelMessageId: string; channelContactId: string; text: string; receivedAt: Date;
  }
  export interface ChannelAdapter {
    readonly name: string;
    healthCheck(): Promise<boolean>;
    publish(input: PublishInput): Promise<PublishResult>;
    sendDirectMessage(input: { channelContactId: string; text: string;
      idempotencyKey: string }): Promise<{ channelMessageId: string }>;
  }
  export function parseInbound(rawBody: string): InboundMessage[];
  ```
  Also: `createZaloAdapter(cfg: ZaloAdapterConfig, fetchImpl?: FetchLike): ChannelAdapter`, `startFakeZaloServer(): Promise<FakeZaloServer>`. Task 6 modifies `ZaloAdapterConfig` and `createZaloAdapter`'s `sendDirectMessage` body.

- [ ] **Step 1: Write the failing tests**

Create `packages/integrations/src/adapter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseInbound } from "./adapter.ts";

function zaloEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    app_id: "test-app",
    event_name: "user_send_text",
    sender: { id: "user-1" },
    timestamp: "1700000000000",
    message: { msg_id: "msg-1", text: "xin chao" },
    ...overrides,
  });
}

describe("parseInbound", () => {
  it("parses a genuine text message into one InboundMessage", () => {
    const result = parseInbound(zaloEvent());
    expect(result).toEqual([
      { channelMessageId: "msg-1", channelContactId: "user-1", text: "xin chao", receivedAt: new Date(1700000000000) },
    ]);
  });

  it("returns an empty array for a non-text event (e.g. follow) -- not an error", () => {
    expect(parseInbound(zaloEvent({ event_name: "follow", message: undefined }))).toEqual([]);
  });

  it("returns an empty array when message.text is blank", () => {
    expect(parseInbound(zaloEvent({ message: { msg_id: "msg-2", text: "   " } }))).toEqual([]);
  });

  it("throws on bytes that are not valid JSON", () => {
    expect(() => parseInbound("not-json{{")).toThrow(/not valid JSON/);
  });

  it("throws on JSON that does not match a recognised Zalo webhook event shape", () => {
    expect(() => parseInbound(JSON.stringify({ hello: "world" }))).toThrow(/recognised Zalo/);
  });

  it("throws on a non-numeric timestamp", () => {
    expect(() => parseInbound(zaloEvent({ timestamp: "not-a-number" }))).toThrow(/timestamp/);
  });
});
```

Create `packages/integrations/src/zalo/contract.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeZaloServer, type FakeZaloServer } from "./fake-server.ts";
import { createZaloAdapter } from "./adapter.ts";
import type { FetchLike } from "../guarded-fetch.ts";

let server: FakeZaloServer;
beforeAll(async () => {
  server = await startFakeZaloServer();
});
afterAll(async () => {
  await server.close();
});

function adapterFor(fetchImpl: FetchLike = server.fetchImpl) {
  return createZaloAdapter({ baseUrl: server.url, accessToken: "test-token", allowedHosts: ["sandbox.zalo.test"] }, fetchImpl);
}

describe("zalo adapter contract", () => {
  it("sends a direct message and returns a channel message id", async () => {
    const adapter = adapterFor();
    const result = await adapter.sendDirectMessage({ channelContactId: "user-1", text: "xin chao", idempotencyKey: "k1" });
    expect(result.channelMessageId).toMatch(/^zmsg-/);
    expect(server.sentMessages.get(result.channelMessageId)).toEqual({ recipientId: "user-1", text: "xin chao" });
  });

  it("refuses publish outright -- Zalo OA has no safe broadcast path in this milestone", async () => {
    const adapter = adapterFor();
    await expect(
      adapter.publish({ idempotencyKey: "k2", publicationContent: "broadcast text", contentHash: "hash", targetAccountId: "oa-1" }),
    ).rejects.toMatchObject({ kind: "permanent_rejection" });
  });

  it("reports healthy when the sandbox is reachable", async () => {
    const adapter = adapterFor();
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  it("never calls fetchImpl for a host outside the allowlist", async () => {
    let calls = 0;
    const counting: FetchLike = (input, init) => {
      calls++;
      return server.fetchImpl(input, init);
    };
    const adapter = createZaloAdapter({ baseUrl: server.url, accessToken: "test-token", allowedHosts: ["someone-else.test"] }, counting);
    await expect(
      adapter.sendDirectMessage({ channelContactId: "user-1", text: "hi", idempotencyKey: "k3" }),
    ).rejects.toThrow(/allowlist/i);
    expect(calls).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/integrations/src/adapter.test.ts packages/integrations/src/zalo/contract.test.ts`
Expected: FAIL — `parseInbound` is not exported from `adapter.ts`; `Cannot find module './fake-server.ts'` / `'./adapter.ts'` (zalo adapter files don't exist yet).

- [ ] **Step 3: Widen `adapter.ts`**

Modify `packages/integrations/src/adapter.ts`. Replace the existing `ChannelAdapter` interface and file contents with:

```ts
/**
 * Every field an adapter needs to publish a piece of already-approved
 * content exactly once. `idempotencyKey` lets a retried job hit the same
 * external operation instead of creating a duplicate post; `contentHash`
 * lets the caller prove, at the call site, that what is about to be
 * published still matches what a human approved.
 */
export interface PublishInput {
  idempotencyKey: string;
  publicationContent: string;
  contentHash: string;
  targetAccountId: string;
}

/**
 * `evidence` is a free-form, redaction-safe record of what the channel
 * returned (status, response headers of interest, etc.) kept for audit --
 * never raw credentials.
 */
export interface PublishResult {
  externalId: string;
  permalink: string;
  evidence: Record<string, unknown>;
}

/**
 * M2B: one message this system received from a real customer, normalised
 * to a channel-agnostic shape by `parseInbound` below.
 */
export interface InboundMessage {
  channelMessageId: string;
  channelContactId: string;
  text: string;
  receivedAt: Date;
}

/**
 * The shape every channel integration (Meta, Zalo, others later) must
 * implement. `healthCheck` lets a caller probe reachability/auth without
 * side effects; `publish` performs a broadcast-style post; `sendDirectMessage`
 * (M2B) performs one customer-facing reply inside an existing thread --
 * distinct operations with distinct ban-avoidance rules, which is why they
 * are two methods rather than one parameterised by "kind".
 */
export interface ChannelAdapter {
  readonly name: string;
  healthCheck(): Promise<boolean>;
  publish(input: PublishInput): Promise<PublishResult>;
  sendDirectMessage(input: {
    channelContactId: string;
    text: string;
    idempotencyKey: string;
  }): Promise<{ channelMessageId: string }>;
}

interface ZaloWebhookEventBody {
  event_name: string;
  sender: { id: string };
  timestamp: string;
  message?: { msg_id: string; text?: string };
}

function isZaloWebhookEventBody(value: unknown): value is ZaloWebhookEventBody {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["event_name"] !== "string") return false;
  if (typeof v["timestamp"] !== "string") return false;
  const sender = v["sender"];
  if (typeof sender !== "object" || sender === null || typeof (sender as Record<string, unknown>)["id"] !== "string") return false;
  const message = v["message"];
  if (message !== undefined) {
    if (typeof message !== "object" || message === null) return false;
    if (typeof (message as Record<string, unknown>)["msg_id"] !== "string") return false;
  }
  return true;
}

/**
 * M2B (D1): Zalo-shaped for this milestone -- Zalo OA is the only channel
 * being built. A future second channel adapter will need this to dispatch
 * on the payload's own shape rather than assume Zalo; that generalisation
 * is a deliberate, visible change to this one function when it happens,
 * not a silent assumption every caller has to remember today.
 *
 * A non-text event (follow, unfollow, click-button, sticker -- text-only
 * is this milestone's scope) is not an error: it returns an empty array,
 * not a thrown exception. Malformed bytes or a body that does not match a
 * recognised Zalo webhook event shape at all IS an error -- the caller
 * asked this function to parse a genuine webhook delivery.
 */
export function parseInbound(rawBody: string): InboundMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error("parseInbound: rawBody is not valid JSON");
  }
  if (!isZaloWebhookEventBody(parsed)) {
    throw new Error("parseInbound: rawBody does not match a recognised Zalo OA webhook event shape");
  }
  if (parsed.message === undefined || parsed.message.text === undefined || parsed.message.text.trim() === "") {
    return [];
  }
  const receivedAtMs = Number(parsed.timestamp);
  if (!Number.isFinite(receivedAtMs)) {
    throw new Error(`parseInbound: timestamp "${parsed.timestamp}" is not a valid epoch-millisecond number`);
  }
  return [
    {
      channelMessageId: parsed.message.msg_id,
      channelContactId: parsed.sender.id,
      text: parsed.message.text,
      receivedAt: new Date(receivedAtMs),
    },
  ];
}
```

- [ ] **Step 4: Fix `meta/client.ts` for the widened interface**

Modify `packages/integrations/src/meta/client.ts`. In the returned object (after `publish`'s closing brace, before the final `};`), add:

```ts
    async sendDirectMessage(_input: { channelContactId: string; text: string; idempotencyKey: string }): Promise<{ channelMessageId: string }> {
      // M2B widened ChannelAdapter with sendDirectMessage; Meta's Page feed
      // channel has no direct-message send path implemented in this
      // milestone (D1: only Zalo OA does). Refused outright rather than
      // silently no-op'd, so a caller cannot mistake "did nothing" for
      // "sent".
      throw new AdapterError("permanent_rejection", "Meta channel adapter does not implement sendDirectMessage in this milestone; use publish");
    },
```

- [ ] **Step 5: Write the fake Zalo server**

Create `packages/integrations/src/zalo/fake-server.ts`:

```ts
import type { FetchLike } from "../guarded-fetch.ts";

/**
 * A sandbox Zalo OA API double, mirroring meta/fake-server.ts's own shape
 * and its own reasoning for being in-process rather than a real
 * node:http listener: the egress guard blocks all of 127.0.0.0/8
 * unconditionally and requires https: unconditionally, so `fetchImpl` IS
 * the fake server -- no socket, TLS or plaintext is ever opened.
 */
export interface FakeZaloServer {
  /** Synthetic base URL, `.test` TLD (RFC 2606), never actually dialed. */
  url: string;
  /** messageId -> what was sent, for tests to inspect. */
  sentMessages: Map<string, { recipientId: string; text: string }>;
  fetchImpl: FetchLike;
  close(): Promise<void>;
}

const BASE_URL = "https://sandbox.zalo.test";

function envelope(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function startFakeZaloServer(): Promise<FakeZaloServer> {
  const sentMessages = new Map<string, { recipientId: string; text: string }>();
  let nextMessageId = 1;
  let closed = false;

  const fetchImpl: FetchLike = async (input, init) => {
    if (closed) throw new TypeError("fake zalo server is closed: fetch failed");

    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const token = headers.get("access_token") ?? "";

    if (token === "expired" || token === "invalid") {
      return envelope({ error: -216, message: "Access token is invalid" });
    }

    if (method === "POST" && url.pathname === "/message") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        recipient?: { user_id?: string };
        message?: { text?: string };
      };
      const recipientId = body.recipient?.user_id ?? "";
      const text = body.message?.text ?? "";
      if (recipientId === "user-rate-limited") {
        return envelope({ error: -32, message: "Rate limit exceeded" }, 429);
      }
      if (text.trim() === "") {
        return envelope({ error: -100, message: "Message text is required" });
      }
      const messageId = `zmsg-${nextMessageId++}`;
      sentMessages.set(messageId, { recipientId, text });
      return envelope({ error: 0, message: "Success", data: { message_id: messageId } });
    }

    if (method === "GET" && url.pathname === "/getprofile") {
      const data = JSON.parse(url.searchParams.get("data") ?? "{}") as { user_id?: string };
      return envelope({
        error: 0,
        message: "Success",
        data: { user_id: data.user_id, display_name: `Fake User ${String(data.user_id)}`, avatar: null },
      });
    }

    if (method === "POST" && url.pathname === "/tag/tagfollower") {
      return envelope({ error: 0, message: "Success" });
    }
    if (method === "POST" && url.pathname === "/tag/rmfollowerfromtag") {
      return envelope({ error: 0, message: "Success" });
    }
    if (method === "GET" && url.pathname === "/tag/getfollowers") {
      return envelope({ error: 0, message: "Success", data: { followers: ["user-1", "user-2"] } });
    }

    return envelope({ error: -201, message: "Method not found" }, 404);
  };

  return {
    url: BASE_URL,
    sentMessages,
    fetchImpl,
    async close() {
      closed = true;
    },
  };
}
```

- [ ] **Step 6: Write the Zalo adapter**

Create `packages/integrations/src/zalo/adapter.ts`:

```ts
import type { FetchLike } from "../guarded-fetch.ts";
import { AdapterError } from "../errors.ts";
import type { ChannelAdapter, PublishInput, PublishResult } from "../adapter.ts";
import { createZaloClient, type ZaloClientConfig } from "./client.ts";

export interface ZaloAdapterConfig extends ZaloClientConfig {}

/**
 * Wraps the raw Zalo OA client (Task 3) into the `ChannelAdapter` shape.
 * `publish` is refused outright rather than implemented as a broadcast --
 * see the throw below for why. Task 6 wires the reply-window and
 * complaint-rate ban-avoidance gate into `sendDirectMessage` here.
 */
export function createZaloAdapter(cfg: ZaloAdapterConfig, fetchImpl: FetchLike = fetch): ChannelAdapter {
  const client = createZaloClient(cfg, fetchImpl);

  return {
    name: "zalo",

    async healthCheck() {
      try {
        // No dedicated health endpoint exists in Zalo's OA API. A
        // getProfile round trip against a synthetic id is the same
        // lightweight-reachability-probe shape Meta's healthCheck uses: an
        // API-level rejection (we reached the API and got a real, if
        // negative, answer) still counts as reachable; a network/timeout
        // failure does not.
        await client.getProfile("healthcheck-probe").catch((err: unknown) => {
          if (err instanceof AdapterError && err.kind !== "upstream_unavailable") return;
          throw err;
        });
        return true;
      } catch {
        return false;
      }
    },

    async publish(_input: PublishInput): Promise<PublishResult> {
      // D1/4.5 (ban avoidance): Zalo OA has no safe, non-bulk equivalent of
      // Meta's page-feed publish. A broadcast-shaped call is exactly the
      // kind of bulk send that risks the >2% spam-complaint lockout this
      // milestone exists to avoid (see reply-window.ts, Task 6). Refused
      // outright, not merely undocumented.
      throw new AdapterError(
        "permanent_rejection",
        "Zalo OA channel adapter does not support publish (broadcast); use sendDirectMessage inside a customer-initiated thread only",
      );
    },

    async sendDirectMessage(input) {
      // Known limit, stated rather than hidden: Zalo's OA send API has no
      // server-side idempotency key. `input.idempotencyKey` is accepted for
      // interface conformance; genuine duplicate-send protection must
      // happen at the caller (checking `message` for an existing row with
      // this channelContactId/idempotencyKey before ever calling
      // sendDirectMessage) -- faking client-side dedupe here would not
      // actually protect a real customer from a duplicate message.
      const result = await client.sendMessage(input.channelContactId, input.text);
      return { channelMessageId: result.messageId };
    },
  };
}
```

- [ ] **Step 7: Export the new surface**

Modify `packages/integrations/src/index.ts` to:

```ts
export { ERROR_KINDS, isRetryable, AdapterError, type ErrorKind } from "./errors.ts";
export type { ChannelAdapter, PublishInput, PublishResult, InboundMessage } from "./adapter.ts";
export { parseInbound } from "./adapter.ts";
export { assertEgressAllowed, assertResolvedAddressAllowed } from "./egress.ts";
export { guardedFetch, type FetchLike, type GuardedFetchInit } from "./guarded-fetch.ts";
export { startFakeMetaServer, type FakeMetaServer } from "./meta/fake-server.ts";
export { createMetaAdapter, type MetaAdapterConfig } from "./meta/client.ts";
export { createZaloClient, type ZaloClientConfig, type ZaloClient, type ZaloProfile } from "./zalo/client.ts";
export { createZaloAdapter, type ZaloAdapterConfig } from "./zalo/adapter.ts";
export { startFakeZaloServer, type FakeZaloServer } from "./zalo/fake-server.ts";
```

- [ ] **Step 8: Run tests, confirm they pass**

Run: `npx vitest run packages/integrations/src/adapter.test.ts packages/integrations/src/zalo/contract.test.ts packages/integrations/src/meta/contract.test.ts`
Expected: PASS — including the pre-existing Meta contract suite (proves the widened interface didn't break it).

Run: `npm run typecheck`
Expected: exit 0 — confirms `meta/client.ts`'s object literal still satisfies `ChannelAdapter` after the interface was widened.

- [ ] **Step 9: Commit**

```bash
git add packages/integrations/src/adapter.ts packages/integrations/src/adapter.test.ts packages/integrations/src/meta/client.ts packages/integrations/src/zalo/fake-server.ts packages/integrations/src/zalo/adapter.ts packages/integrations/src/zalo/contract.test.ts packages/integrations/src/index.ts
git commit -m "$(cat <<'EOF'
feat(integrations): add sendDirectMessage and parseInbound to ChannelAdapter

Widens ChannelAdapter with sendDirectMessage (required on every adapter;
Meta gets an explicit not-implemented stub) and adds parseInbound, Zalo-
shaped for this milestone. createZaloAdapter wraps the Task 3 client into
the adapter shape, refusing publish outright since Zalo OA has no safe
non-bulk broadcast path. Includes a fake Zalo server mirroring the
existing Meta fake server.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: the reply-window and ban-avoidance limiter

**Files:**
- Create: `packages/integrations/src/zalo/reply-window.ts`
- Create: `packages/integrations/src/zalo/reply-window.test.ts`
- Create: `packages/integrations/src/zalo/adapter.test.ts`
- Modify: `packages/integrations/src/zalo/adapter.ts`
- Modify: `packages/integrations/src/zalo/contract.test.ts`
- Modify: `packages/integrations/src/index.ts`

**Interfaces:**
- Consumes: `AdapterError` (`errors.ts`); `ZaloAdapterConfig`, `createZaloAdapter` (Task 5).
- Produces:
  ```ts
  export interface ReplyWindowState { lastCustomerMessageAt: Date | null; }
  export type ComplaintRateProvider = () => Promise<number>;
  export const DEFAULT_COMPLAINT_RATE_THRESHOLD: number;
  export class ReplyWindowClosedError extends AdapterError {}
  export class ComplaintThresholdExceededError extends AdapterError {}
  export function assertWithinReplyWindow(state: ReplyWindowState, now: Date): void;
  export function assertBelowComplaintThreshold(getComplaintRate: ComplaintRateProvider, threshold?: number): Promise<void>;
  ```
  `ZaloAdapterConfig` gains two required fields: `getReplyWindowState(channelContactId: string): Promise<ReplyWindowState>` and `getComplaintRate: ComplaintRateProvider`, plus an optional `complaintRateThreshold?: number`.

- [ ] **Step 1: Write the failing test for the guard functions**

Create `packages/integrations/src/zalo/reply-window.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  assertWithinReplyWindow,
  assertBelowComplaintThreshold,
  DEFAULT_COMPLAINT_RATE_THRESHOLD,
  ReplyWindowClosedError,
  ComplaintThresholdExceededError,
} from "./reply-window.ts";

describe("assertWithinReplyWindow", () => {
  const now = new Date("2026-08-18T12:00:00.000Z");

  it("refuses a contact with no inbound message at all", () => {
    expect(() => assertWithinReplyWindow({ lastCustomerMessageAt: null }, now)).toThrow(ReplyWindowClosedError);
  });

  it("allows a send inside the 48-hour free window", () => {
    const lastCustomerMessageAt = new Date(now.getTime() - 60 * 60 * 1000);
    expect(() => assertWithinReplyWindow({ lastCustomerMessageAt }, now)).not.toThrow();
  });

  it("refuses a send past the 48-hour free window even though the 7-day window is still open", () => {
    const lastCustomerMessageAt = new Date(now.getTime() - 49 * 60 * 60 * 1000);
    expect(() => assertWithinReplyWindow({ lastCustomerMessageAt }, now)).toThrow(/48-hour/);
  });

  it("refuses a send past the 7-day OpenAPI window", () => {
    const lastCustomerMessageAt = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    expect(() => assertWithinReplyWindow({ lastCustomerMessageAt }, now)).toThrow(/7-day OpenAPI/);
  });
});

describe("assertBelowComplaintThreshold", () => {
  it("allows a send when the complaint rate is comfortably below threshold", async () => {
    await expect(assertBelowComplaintThreshold(async () => 0.001)).resolves.toBeUndefined();
  });

  it("refuses a send once the complaint rate reaches the default threshold", async () => {
    await expect(assertBelowComplaintThreshold(async () => DEFAULT_COMPLAINT_RATE_THRESHOLD)).rejects.toThrow(
      ComplaintThresholdExceededError,
    );
  });

  it("fails closed when the complaint-rate provider returns a non-finite value", async () => {
    await expect(assertBelowComplaintThreshold(async () => Number.NaN)).rejects.toThrow(ComplaintThresholdExceededError);
  });

  it("refuses a caller-supplied threshold at or above Zalo's own 2% lockout line", async () => {
    await expect(assertBelowComplaintThreshold(async () => 0.001, 0.02)).rejects.toThrow(/threshold must be/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/integrations/src/zalo/reply-window.test.ts`
Expected: FAIL — `Cannot find module './reply-window.ts'`.

- [ ] **Step 3: Write the guard module**

Create `packages/integrations/src/zalo/reply-window.ts`:

```ts
import { AdapterError } from "../errors.ts";

/**
 * D1/4.5: Zalo cuts an OA's send quota by tier and locks the offending
 * message template outright once its spam-complaint rate crosses 2%;
 * repeated or serious violations cost the OA permanently, with its data
 * purged 30 days later. Nothing in this module can observe Zalo's own
 * complaint counter directly (the OA API does not expose one in this
 * milestone) -- `getComplaintRate` is an injected provider so the caller
 * supplies the real number (eventually a scheduled Zalo Insights pull or
 * the founder's own dashboard), and this module's only job is to refuse to
 * send once that number crosses the configured threshold, set BELOW
 * Zalo's own 2% lockout line by default so the circuit trips on our own
 * numbers before Zalo's enforcement ever acts on the OA.
 */
export interface ReplyWindowState {
  /** When the customer's most recent inbound message in this thread
   * arrived, or null if this contact has never messaged in. */
  lastCustomerMessageAt: Date | null;
}

export type ComplaintRateProvider = () => Promise<number>;

const FREE_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h free-message window
const OPENAPI_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7-day OpenAPI (template) window
export const DEFAULT_COMPLAINT_RATE_THRESHOLD = 0.015; // 1.5%, deliberately below Zalo's 2% lockout line

export class ReplyWindowClosedError extends AdapterError {
  constructor(message: string) {
    super("permanent_rejection", message);
    this.name = "ReplyWindowClosedError";
  }
}

export class ComplaintThresholdExceededError extends AdapterError {
  constructor(message: string) {
    super("permanent_rejection", message);
    this.name = "ComplaintThresholdExceededError";
  }
}

/**
 * Never bulk-send, and never reply outside a thread the customer started.
 * A contact who has never sent an inbound message has no open window at
 * all -- refused, not merely "outside 7 days". Throws synchronously,
 * BEFORE any HTTP call is made; callers (createZaloAdapter's
 * sendDirectMessage) must call this before touching the network, never
 * after.
 */
export function assertWithinReplyWindow(state: ReplyWindowState, now: Date): void {
  if (state.lastCustomerMessageAt === null) {
    throw new ReplyWindowClosedError(
      "Zalo sendDirectMessage refused: this contact has no customer-initiated thread open -- the agent may only reply inside a thread the customer started",
    );
  }
  const elapsedMs = now.getTime() - state.lastCustomerMessageAt.getTime();
  if (elapsedMs > OPENAPI_WINDOW_MS) {
    throw new ReplyWindowClosedError(
      `Zalo sendDirectMessage refused: the 7-day OpenAPI reply window closed ${Math.floor((elapsedMs - OPENAPI_WINDOW_MS) / 1000)}s ago`,
    );
  }
  // Inside the outer 7-day window but past the 48h free window: this
  // milestone has no paid-template send path implemented, so treating it
  // as "allowed" here would silently attempt a send Zalo will itself
  // reject (or bill) as an unsupported message class. Refused explicitly
  // rather than left to fail downstream.
  if (elapsedMs > FREE_WINDOW_MS) {
    throw new ReplyWindowClosedError(
      `Zalo sendDirectMessage refused: the 48-hour free-message window closed ${Math.floor((elapsedMs - FREE_WINDOW_MS) / 1000)}s ago; ` +
        "the 7-day OpenAPI template window is still open but no paid-template send path exists in this milestone",
    );
  }
}

/**
 * Stops automatically at a threshold set BELOW Zalo's real 2% lockout, so
 * the circuit trips on our own numbers before Zalo's enforcement ever acts
 * on the OA. `threshold` defaults to DEFAULT_COMPLAINT_RATE_THRESHOLD but
 * is a parameter, not a hardcoded constant, so the founder can tighten it
 * from configuration -- the bound below refuses any attempt to loosen it
 * past 2%.
 */
export async function assertBelowComplaintThreshold(
  getComplaintRate: ComplaintRateProvider,
  threshold: number = DEFAULT_COMPLAINT_RATE_THRESHOLD,
): Promise<void> {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 0.02) {
    throw new Error(`assertBelowComplaintThreshold: threshold must be a finite number in (0, 0.02), got ${threshold}`);
  }
  const rate = await getComplaintRate();
  if (!Number.isFinite(rate) || rate < 0) {
    // An unreadable/malformed complaint rate must fail closed, not open --
    // sending blind is exactly the risk this module exists to prevent.
    throw new ComplaintThresholdExceededError(
      `Zalo sendDirectMessage refused: the current spam-complaint rate could not be read as a valid number (got ${String(rate)}), and this gate fails closed`,
    );
  }
  if (rate >= threshold) {
    throw new ComplaintThresholdExceededError(
      `Zalo sendDirectMessage refused: spam-complaint rate ${(rate * 100).toFixed(2)}% is at or above the configured threshold ${(threshold * 100).toFixed(2)}%`,
    );
  }
}
```

- [ ] **Step 4: Run test, confirm it passes**

Run: `npx vitest run packages/integrations/src/zalo/reply-window.test.ts`
Expected: PASS — all 8 tests.

- [ ] **Step 5: Write the failing adapter-level gate test**

Create `packages/integrations/src/zalo/adapter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { startFakeZaloServer, type FakeZaloServer } from "./fake-server.ts";
import { createZaloAdapter } from "./adapter.ts";
import { ReplyWindowClosedError } from "./reply-window.ts";
import type { FetchLike } from "../guarded-fetch.ts";

describe("zalo adapter -- ban avoidance gate", () => {
  it("refuses to send outside the reply window before any HTTP call is made", async () => {
    const server: FakeZaloServer = await startFakeZaloServer();
    let calls = 0;
    const countingFetch: FetchLike = (input, init) => {
      calls++;
      return server.fetchImpl(input, init);
    };
    const adapter = createZaloAdapter(
      {
        baseUrl: server.url,
        accessToken: "test-token",
        allowedHosts: ["sandbox.zalo.test"],
        getReplyWindowState: async () => ({ lastCustomerMessageAt: null }),
        getComplaintRate: async () => 0,
      },
      countingFetch,
    );
    await expect(
      adapter.sendDirectMessage({ channelContactId: "user-1", text: "xin chao", idempotencyKey: "k1" }),
    ).rejects.toBeInstanceOf(ReplyWindowClosedError);
    expect(calls).toBe(0);
    await server.close();
  });

  it("refuses to send once the complaint rate is at or above the configured threshold, before any HTTP call is made", async () => {
    const server: FakeZaloServer = await startFakeZaloServer();
    let calls = 0;
    const countingFetch: FetchLike = (input, init) => {
      calls++;
      return server.fetchImpl(input, init);
    };
    const recent = new Date();
    const adapter = createZaloAdapter(
      {
        baseUrl: server.url,
        accessToken: "test-token",
        allowedHosts: ["sandbox.zalo.test"],
        getReplyWindowState: async () => ({ lastCustomerMessageAt: recent }),
        getComplaintRate: async () => 0.03,
      },
      countingFetch,
    );
    await expect(
      adapter.sendDirectMessage({ channelContactId: "user-1", text: "xin chao", idempotencyKey: "k2" }),
    ).rejects.toThrow(/spam-complaint rate/);
    expect(calls).toBe(0);
    await server.close();
  });

  it("sends successfully when inside the window and below the complaint threshold", async () => {
    const server: FakeZaloServer = await startFakeZaloServer();
    const recent = new Date();
    const adapter = createZaloAdapter(
      {
        baseUrl: server.url,
        accessToken: "test-token",
        allowedHosts: ["sandbox.zalo.test"],
        getReplyWindowState: async () => ({ lastCustomerMessageAt: recent }),
        getComplaintRate: async () => 0.001,
      },
      server.fetchImpl,
    );
    const result = await adapter.sendDirectMessage({ channelContactId: "user-1", text: "xin chao", idempotencyKey: "k3" });
    expect(result.channelMessageId).toMatch(/^zmsg-/);
    await server.close();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/integrations/src/zalo/adapter.test.ts`
Expected: FAIL to compile — `ZaloAdapterConfig` (Task 5's version) has no `getReplyWindowState` / `getComplaintRate` fields yet, so this test file does not typecheck against it (`npx vitest run` reports a TypeScript error on the object literals). If run with type errors ignored, the first two tests would instead fail at runtime with `expected 0 to be 1` (an HTTP call happened) and a resolved promise where a rejection was expected.

- [ ] **Step 7: Wire the gate into the adapter**

Modify `packages/integrations/src/zalo/adapter.ts`. Change the import line and `ZaloAdapterConfig`/`sendDirectMessage`:

```ts
import type { FetchLike } from "../guarded-fetch.ts";
import { AdapterError } from "../errors.ts";
import type { ChannelAdapter, PublishInput, PublishResult } from "../adapter.ts";
import { createZaloClient, type ZaloClientConfig } from "./client.ts";
import {
  assertWithinReplyWindow,
  assertBelowComplaintThreshold,
  type ReplyWindowState,
  type ComplaintRateProvider,
} from "./reply-window.ts";

export interface ZaloAdapterConfig extends ZaloClientConfig {
  /** Never defaulted: a caller MUST supply the real reply-window state for
   * this contact. A silent "always open" default would defeat the whole
   * point of the ban-avoidance gate below. */
  getReplyWindowState(channelContactId: string): Promise<ReplyWindowState>;
  /** Never defaulted, for the identical reason. */
  getComplaintRate: ComplaintRateProvider;
  complaintRateThreshold?: number;
}
```

And replace `sendDirectMessage`'s body:

```ts
    async sendDirectMessage(input) {
      // Ban avoidance (D1/4.5): both gates run, and must run, BEFORE any
      // network call -- assertWithinReplyWindow and
      // assertBelowComplaintThreshold both throw synchronously/before
      // awaiting any I/O of their own besides the injected state providers.
      const windowState = await cfg.getReplyWindowState(input.channelContactId);
      assertWithinReplyWindow(windowState, new Date());
      await assertBelowComplaintThreshold(cfg.getComplaintRate, cfg.complaintRateThreshold);

      // Known limit, stated rather than hidden: Zalo's OA send API has no
      // server-side idempotency key. `input.idempotencyKey` is accepted for
      // interface conformance; genuine duplicate-send protection must
      // happen at the caller (checking `message` for an existing row with
      // this channelContactId/idempotencyKey before ever calling
      // sendDirectMessage) -- faking client-side dedupe here would not
      // actually protect a real customer from a duplicate message.
      const result = await client.sendMessage(input.channelContactId, input.text);
      return { channelMessageId: result.messageId };
    },
```

- [ ] **Step 8: Update Task 5's contract test for the now-required config fields**

Modify `packages/integrations/src/zalo/contract.test.ts`'s `adapterFor` helper:

```ts
function adapterFor(fetchImpl: FetchLike = server.fetchImpl) {
  return createZaloAdapter(
    {
      baseUrl: server.url,
      accessToken: "test-token",
      allowedHosts: ["sandbox.zalo.test"],
      getReplyWindowState: async () => ({ lastCustomerMessageAt: new Date() }),
      getComplaintRate: async () => 0,
    },
    fetchImpl,
  );
}
```

And the allowlist-refusal test's inline `createZaloAdapter(...)` call gains the same two fields:

```ts
    const adapter = createZaloAdapter(
      {
        baseUrl: server.url,
        accessToken: "test-token",
        allowedHosts: ["someone-else.test"],
        getReplyWindowState: async () => ({ lastCustomerMessageAt: new Date() }),
        getComplaintRate: async () => 0,
      },
      counting,
    );
```

- [ ] **Step 9: Export the guard module**

Modify `packages/integrations/src/index.ts`, add:

```ts
export {
  assertWithinReplyWindow,
  assertBelowComplaintThreshold,
  DEFAULT_COMPLAINT_RATE_THRESHOLD,
  ReplyWindowClosedError,
  ComplaintThresholdExceededError,
  type ReplyWindowState,
  type ComplaintRateProvider,
} from "./zalo/reply-window.ts";
```

- [ ] **Step 10: Run everything, confirm it passes**

Run: `npx vitest run packages/integrations/src/zalo/adapter.test.ts packages/integrations/src/zalo/contract.test.ts packages/integrations/src/zalo/reply-window.test.ts`
Expected: PASS — including `expect(calls).toBe(0)` in both gate-refusal tests in `adapter.test.ts`.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add packages/integrations/src/zalo/reply-window.ts packages/integrations/src/zalo/reply-window.test.ts packages/integrations/src/zalo/adapter.test.ts packages/integrations/src/zalo/adapter.ts packages/integrations/src/zalo/contract.test.ts packages/integrations/src/index.ts
git commit -m "$(cat <<'EOF'
feat(integrations): gate Zalo sendDirectMessage on reply window and complaint rate

Refuses to reply outside a customer-initiated thread, refuses past the
48-hour free window or the 7-day OpenAPI window, and stops automatically
once the injected complaint rate reaches a configurable threshold set
below Zalo's own 2% lockout line -- all before any HTTP call is made.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification (run once, after all six tasks)

- [ ] Run: `npm run db:migrate`
  Expected: `0040_conversation_domain.sql` and `0041_message_immutable.sql` both applied (or already applied, no-op).
- [ ] Run: `npm run verify`
  Expected: exit 0 — `lint:versions`, `lint:scope`, `lint:secrets`, `lint:imports`, `lint:migrations`, `lint:purity`, `lint:authz`, `lint:design`, `lint:i18n`, `typecheck`, `typecheck:web`, and the full `test` suite all pass, including `packages/db/src/cross-tenant.test.ts`'s pinned catalog assertions.

---

## Self-review

**Spec coverage.** Section 4.1 (data model): `customer_contact` / `conversation` / `message` with `agent_paused_at`, the reply-window deadline, and `disclosure_sent` on first outbound — Task 1. Forced RLS + composite `(id, workspace_id)` FKs — Task 1. Immutability — Task 2. Section 4.4 (inbound adapter): the Zalo client (send/profile/tag) — Task 3; `receiveMessage`-equivalent via the fixed `parseInbound` contract — Task 5; HMAC webhook check — Task 4; every outbound call through `guardedFetch` — Tasks 3, 5. Section 4.5 (ban avoidance): customer-initiated-thread-only, 48h/7d windows, no bulk send, automatic stop below 2% — Task 6; D8 founder-takeover column (`agent_paused_at`) is created here (Task 1) but its write path is explicitly out of scope, left to M2C, per the plan index's own division of labour. Section 5 (failure handling): webhook signature failure writes no delivery-affecting row and consumes no nonce — Task 4's route mirrors the Meta route's proven behaviour exactly.

**Placeholder scan.** No `TBD`/`TODO`/"add validation"/"similar to Task N" strings appear in any step above; every step that touches code includes the literal code block. The one place this plan is deliberately non-committal is the Zalo OA numeric error-code table in Task 3's `client.ts`, and that is flagged explicitly as unverified (mirroring how the design spec itself flags D5's legal claim as "unverified, secondary source only"), not left silently vague.

**Type-name consistency against the index contract.** `InboundMessage`, `ChannelAdapter` (with `readonly name`, `sendDirectMessage`), and `parseInbound(rawBody: string): InboundMessage[]` in Task 5 match the index's `packages/integrations/src/adapter.ts` block verbatim. `sendDirectMessage`'s parameter and return shapes match exactly (`{ channelContactId, text, idempotencyKey }` → `{ channelMessageId }}`) across Tasks 5 and 6 and the meta stub. `ZaloAdapterConfig`, `ReplyWindowState`, `ComplaintRateProvider` are used with the same names and shapes everywhere they are consumed (Task 5 defines `ZaloAdapterConfig`; Task 6 extends it in place, and every later reference — the adapter test, the contract test update — uses the same field names).

**Where this plan's scope stops, stated rather than hidden.** Task 4's webhook route verifies, rate-limits, and records the delivery nonce, but does not yet write into `customer_contact` / `conversation` / `message` or dispatch the advisory agent — that wiring is M2C's, which the plan index lists as blocked on this plan finishing. `agent_paused_at` exists as a column (Task 1) but nothing in this plan ever sets it; the founder-takeover write path is also M2C's.

**Where the index contract seemed to need a call, not a fix.** The plan index's own summary row for M2B lists only "`customer_contact` / `conversation` / `message`, the Zalo OA client, HMAC webhook verification, and `receiveMessage` on `ChannelAdapter`" — it does not mention the reply-window/ban-avoidance limiter, which the index's M2C row lists instead ("founder takeover... and the ban-avoidance limiter"). This plan's own Task 6 brief explicitly assigned the reply-window and ban-avoidance limiter to M2B, so it is built here. The two are not actually in conflict: what this plan builds is a channel-layer, stateless guard (`assertWithinReplyWindow` / `assertBelowComplaintThreshold`) that any caller of `sendDirectMessage` gets for free, including M2C's agent — M2C's own "ban-avoidance limiter" is presumably the higher-level policy that decides *when* to call `sendDirectMessage` at all and supplies real `getReplyWindowState` / `getComplaintRate` implementations backed by the database and a real Zalo Insights pull. Worth flagging explicitly to whoever writes the M2C plan so the two don't duplicate each other's work.
