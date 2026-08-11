-- Task 10: agent registry. Fifteen roles exist as contracts
-- (packages/domain/src/agent-registry.ts, ALL_AGENT_ROLES); only four are
-- activated for M1 (M1_ACTIVATED_AGENTS). assertActivated is the code-side
-- gate that stops a non-activated agent from ever being dispatched -- in P2
-- that means it never creates an AgentRun and never calls a paid model
-- provider, which makes it the primary cost control for the whole project.
-- This migration is the database-side half of that: agent_version.activated
-- records, per version, whether a role may run at all.
--
-- Both tables are workspace-owned per ADR-007: workspace_id NOT NULL, RLS
-- ENABLED and FORCED, and a policy carrying both USING and WITH CHECK so
-- smos_app can neither read nor write across a tenant boundary.
--
-- `role` is a state-like column constrained the same way content_item.kind
-- and campaign.state are (0006_content.sql, 0005_campaign_state_check.sql):
-- the CHECK list below MUST mirror packages/domain/src/agent-registry.ts's
-- ALL_AGENT_ROLES exactly and is changed only alongside it. As of this
-- migration, the fifteen roles are: orchestrator, research, icp_strategist,
-- brand_offer_strategist, campaign_planner, content, creative_director,
-- seo_aeo, social_distribution, crm_lifecycle, paid_media_advisor,
-- cro_experiment, data_analyst, qa_brand_safety, integration_reliability.
--
-- Text CHECKs use `x ~ '\S'`, never `btrim(...)`: PostgreSQL's
-- single-argument btrim() strips only ASCII spaces and lets a value made
-- solely of tabs/newlines through (0009_check_whitespace_hardening.sql).
CREATE TABLE IF NOT EXISTS agent_definition (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  role         text NOT NULL CHECK (role IN (
    'orchestrator', 'research', 'icp_strategist', 'brand_offer_strategist', 'campaign_planner',
    'content', 'creative_director', 'seo_aeo', 'social_distribution', 'crm_lifecycle',
    'paid_media_advisor', 'cro_experiment', 'data_analyst', 'qa_brand_safety', 'integration_reliability'
  )),
  mission      text NOT NULL CHECK (mission ~ '\S'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, role),
  -- Required so agent_version's composite FK below can reference
  -- (id, workspace_id) -- redundant with the primary key (id alone is
  -- already unique) but PostgreSQL requires the pair itself to be backed by
  -- a UNIQUE or PRIMARY KEY constraint for a composite FK to target it.
  UNIQUE (id, workspace_id)
);
ALTER TABLE agent_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definition FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_definition_tenant_isolation ON agent_definition;
CREATE POLICY agent_definition_tenant_isolation ON agent_definition
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- agent_definition_id deliberately has no plain REFERENCES here: PostgreSQL
-- evaluates a foreign key against its referenced table with RLS bypassed
-- entirely, so a single-column FK would only prove that *some*
-- agent_definition with that id exists anywhere in the database, never that
-- it belongs to the same workspace as this agent_version row
-- (0008_composite_tenant_fk.sql documents the identical hole and fixes it
-- for every pre-existing pair). The composite FK at the bottom of this
-- table definition is what actually enforces the reference.
CREATE TABLE IF NOT EXISTS agent_version (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES workspace(id),
  agent_definition_id uuid NOT NULL,
  version_number      integer NOT NULL CHECK (version_number > 0),
  activated           boolean NOT NULL DEFAULT false,
  tool_allowlist      jsonb NOT NULL DEFAULT '[]'::jsonb,
  prohibited_actions  jsonb NOT NULL DEFAULT '[]'::jsonb,
  prompt_version      text NOT NULL CHECK (prompt_version ~ '\S'),
  model_version       text NOT NULL CHECK (model_version ~ '\S'),
  budget_usd          numeric(10,4) NOT NULL CHECK (budget_usd > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_definition_id, version_number),
  FOREIGN KEY (agent_definition_id, workspace_id) REFERENCES agent_definition (id, workspace_id)
);
ALTER TABLE agent_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_version FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_version_tenant_isolation ON agent_version;
CREATE POLICY agent_version_tenant_isolation ON agent_version
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON agent_definition, agent_version TO smos_app;
