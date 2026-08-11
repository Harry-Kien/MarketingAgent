-- Task 9: the publication artifact contract (E3). A publication cannot exist
-- without the verbatim text that will actually be posted, and cannot exist
-- without a recorded human approval decision. Task 8 already made it
-- impossible for an agent to record that approval (0007_approval.sql,
-- 0008_composite_tenant_fk.sql); this migration makes it impossible to
-- publish without one.
--
-- Following 0008's pattern exactly: publication references campaign,
-- content_version and approval_decision, and all three are workspace-owned.
-- PostgreSQL evaluates a foreign key against its referenced table with RLS
-- bypassed entirely (0008's header comment explains why), so a plain
-- single-column FK on any of those three would only prove "a row with this
-- id exists somewhere", never "it belongs to the same workspace as the
-- publication being inserted" -- letting a session scoped to workspace B
-- attach a publication to workspace A's campaign, content_version or
-- approval decision. Every one of the three FKs below is therefore
-- composite: (referenced_id, workspace_id) against a UNIQUE (id,
-- workspace_id) on the parent.
--
-- campaign and content_version already have that UNIQUE constraint from
-- 0008. approval_decision does not -- 0008 treated it as a leaf, since
-- nothing referenced it yet. This migration is the first thing to reference
-- it, so the UNIQUE (id, workspace_id) is added here, immediately before the
-- FK that depends on it, exactly as 0008 orders each parent's UNIQUE before
-- its child's FK.
ALTER TABLE approval_decision ADD CONSTRAINT approval_decision_id_workspace_id_key UNIQUE (id, workspace_id);

-- publication_content and target_channel use `~ '\S'` (matches only if the
-- string contains a non-whitespace character), not `length(btrim(x)) > 0`:
-- 0009 established that PostgreSQL's single-argument btrim() strips only
-- ASCII spaces, so a value made only of tabs/newlines would pass the older
-- form while `.trim()` in buildPublication (packages/domain/src/publication.ts)
-- rejects the identical string as blank. The database must refuse exactly
-- what the domain refuses.
--
-- publication_content is NOT NULL (unlike content_version.publication_content,
-- which stays nullable until an agent sets it) -- a publication row is only
-- ever created once buildPublication has already confirmed real text exists,
-- so there is never a legitimate reason for this column to be null or blank
-- here. This CHECK is the database-level half of that guarantee; the
-- domain-level half is buildPublication's own refusal, which runs first.
CREATE TABLE IF NOT EXISTS publication (
  id                   uuid PRIMARY KEY,
  workspace_id         uuid NOT NULL REFERENCES workspace(id),
  campaign_id          uuid NOT NULL,
  content_version_id   uuid NOT NULL,
  -- E3: a publication is impossible without a recorded human approval.
  approval_decision_id uuid NOT NULL,
  publication_content  text NOT NULL CHECK (publication_content ~ '\S'),
  content_hash         text NOT NULL,
  idempotency_key      text NOT NULL UNIQUE,
  target_channel       text NOT NULL CHECK (target_channel ~ '\S'),
  state                text NOT NULL CHECK (state IN ('prepared','executing','succeeded','failed')),
  external_id          text,
  permalink            text,
  evidence             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publication_campaign_id_workspace_fkey
    FOREIGN KEY (campaign_id, workspace_id) REFERENCES campaign (id, workspace_id),
  CONSTRAINT publication_content_version_id_workspace_fkey
    FOREIGN KEY (content_version_id, workspace_id) REFERENCES content_version (id, workspace_id),
  CONSTRAINT publication_approval_decision_id_workspace_fkey
    FOREIGN KEY (approval_decision_id, workspace_id) REFERENCES approval_decision (id, workspace_id)
);
ALTER TABLE publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE publication FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS publication_tenant_isolation ON publication;
CREATE POLICY publication_tenant_isolation ON publication
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- UPDATE is granted (unlike approval_decision, which revokes it) because a
-- publication legitimately transitions state after insert: prepared ->
-- executing -> succeeded/failed, as a later task drives the connector call.
-- Nothing in this migration pins publication_content or content_hash
-- immutable the way 0007 pins approval_decision immutable -- see
-- task-9-report.md for why that is a real, currently-open drift risk rather
-- than an oversight.
GRANT SELECT, INSERT, UPDATE ON publication TO smos_app;
