-- Task 7: content items, their versions, and the source citations that back
-- claims inside a version. All three are workspace-owned per ADR-007:
-- workspace_id NOT NULL, RLS ENABLED and FORCED, and a policy carrying both
-- USING and WITH CHECK so smos_app can neither read nor write across a
-- tenant boundary.
--
-- Per Task 6's precedent (campaign_state_check), `kind` and
-- `verification_status` are state-like columns and are constrained here, not
-- only in TypeScript. The two CHECK lists below MUST mirror
-- packages/domain/src/content.ts's CONTENT_KINDS and VERIFICATION_STATUSES
-- exactly -- the two are changed together, never independently. As of this
-- migration:
--   CONTENT_KINDS:        social_post, email, landing_page, long_form, faq
--   VERIFICATION_STATUSES: VERIFIED, INFERRED, HYPOTHESIS, UNVERIFIED
CREATE TABLE IF NOT EXISTS content_item (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  campaign_id  uuid NOT NULL REFERENCES campaign(id),
  kind         text NOT NULL CHECK (kind IN ('social_post','email','landing_page','long_form','faq')),
  title        text NOT NULL CHECK (length(btrim(title)) > 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE content_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_item FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_item_tenant_isolation ON content_item;
CREATE POLICY content_item_tenant_isolation ON content_item
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- publication_content is the verbatim text that will later be published
-- (Task 9 refuses to build a publication when it is missing or blank); it
-- stays nullable here because addVersion keeps it null until an agent
-- explicitly sets it (packages/domain/src/content.ts). version_number
-- uniqueness per content item is enforced by the UNIQUE constraint below,
-- not only by addVersion in TypeScript.
CREATE TABLE IF NOT EXISTS content_version (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES workspace(id),
  content_item_id     uuid NOT NULL REFERENCES content_item(id),
  version_number      integer NOT NULL CHECK (version_number > 0),
  body                text NOT NULL CHECK (length(btrim(body)) > 0),
  publication_content text,
  quality_score       integer CHECK (quality_score BETWEEN 0 AND 100),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_item_id, version_number)
);
ALTER TABLE content_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_version FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_version_tenant_isolation ON content_version;
CREATE POLICY content_version_tenant_isolation ON content_version
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- verification_status is what lets the system distinguish a claim that has a
-- real source from one that does not; the P2 QA agent blocks content whose
-- citations are not VERIFIED, so this column is constrained at the database
-- the same way content_item.kind and campaign.state are.
CREATE TABLE IF NOT EXISTS source_citation (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES workspace(id),
  content_version_id  uuid NOT NULL REFERENCES content_version(id),
  url                 text NOT NULL,
  accessed_at         timestamptz NOT NULL,
  excerpt             text NOT NULL,
  verification_status text NOT NULL CHECK (verification_status IN ('VERIFIED','INFERRED','HYPOTHESIS','UNVERIFIED')),
  created_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE source_citation ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_citation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS source_citation_tenant_isolation ON source_citation;
CREATE POLICY source_citation_tenant_isolation ON source_citation
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON content_item, content_version, source_citation TO smos_app;
