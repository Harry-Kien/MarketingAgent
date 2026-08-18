-- M2A Task 5: knowledge_document and knowledge_chunk -- the ingested source
-- material the customer-advisory agent (M2C) may ground a reply in, and the
-- provenance tier (D3, docs/superpowers/specs/2026-08-18-customer-advisory-
-- agent-design.md section 2) that bounds what each chunk may be used to
-- assert. pgvector's `vector` extension is already enabled by
-- 0000_init_extensions.sql; this is the first migration to use it.
--
-- Both tables are workspace-owned per ADR-007: workspace_id NOT NULL, RLS
-- ENABLED and FORCED, and a policy carrying both USING and WITH CHECK, in
-- the same pattern as every table since 0001_core_tenancy.sql.
--
-- knowledge_chunk's foreign key to knowledge_document is composite on
-- (id, workspace_id), exactly like 0008_composite_tenant_fk.sql /
-- 0028_integration.sql: PostgreSQL evaluates a foreign key against its
-- referenced table with RLS bypassed entirely, so a plain single-column
-- `REFERENCES knowledge_document(id)` would only prove "some document with
-- this id exists anywhere", never that it belongs to the same workspace as
-- the chunk -- letting a session scoped to workspace B attach a chunk to
-- workspace A's document and silently inherit that document's tier.
-- knowledge_document gets UNIQUE (id, workspace_id) so the child's
-- composite FK has something to target.
--
-- Text CHECKs use `x ~ '\S'`, never a length check
-- (0009_check_whitespace_hardening.sql).

CREATE TABLE IF NOT EXISTS knowledge_document (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  tier         text NOT NULL CHECK (tier IN ('t1_authoritative', 't2_reference', 't3_hint', 't4_voice')),
  title        text NOT NULL CHECK (title ~ '\S'),
  source_uri   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Required so knowledge_chunk's composite FK below can target
  -- (id, workspace_id) -- redundant with the primary key alone already
  -- being unique, but PostgreSQL requires the pair itself to be backed by
  -- a UNIQUE or PRIMARY KEY constraint for a composite FK to reference it.
  UNIQUE (id, workspace_id)
);
ALTER TABLE knowledge_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_document FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_document_tenant_isolation ON knowledge_document;
CREATE POLICY knowledge_document_tenant_isolation ON knowledge_document
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- knowledge_chunk carries embedding vector(1024) -- 1024 dimensions to
-- match the two candidate Vietnamese embedding models named in the
-- dependency audit (AITeamVN/Vietnamese_Embedding, a bge-m3 fine-tune, and
-- BAAI/bge-m3 itself both embed at 1024), not a framework default.
-- `embedding` is nullable: chunk text is written by ingestion (chunk.ts)
-- before the embedding step runs, and this table must be able to hold a
-- chunk in that intermediate state rather than force a single all-or-
-- nothing transaction across chunking and a paid embedding call.
-- `ordinal` is the chunk's position within its document, produced by
-- chunk.ts's ordinal-numbered output.
CREATE TABLE IF NOT EXISTS knowledge_chunk (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  document_id  uuid NOT NULL,
  ordinal      integer NOT NULL CHECK (ordinal >= 0),
  text         text NOT NULL CHECK (text ~ '\S'),
  embedding    vector(1024),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, ordinal),
  FOREIGN KEY (document_id, workspace_id) REFERENCES knowledge_document (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_chunk_ws_document_idx ON knowledge_chunk (workspace_id, document_id);
ALTER TABLE knowledge_chunk ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunk FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_chunk_tenant_isolation ON knowledge_chunk;
CREATE POLICY knowledge_chunk_tenant_isolation ON knowledge_chunk
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- No DELETE grant, matching every other workspace-owned table's runtime
-- grant list (0004_campaign.sql, 0012_agent_registry.sql,
-- 0028_integration.sql): smos_app reads, inserts and updates but never
-- deletes. Test cleanup goes through DATABASE_MIGRATION_URL (the smos
-- role), same as every other integration test in packages/db/src.
GRANT SELECT, INSERT, UPDATE ON knowledge_document, knowledge_chunk TO smos_app;
