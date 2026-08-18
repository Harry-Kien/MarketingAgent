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
