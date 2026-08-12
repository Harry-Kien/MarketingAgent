-- P2 Task 6: agent_run, tool_call, run_checkpoint -- the runtime's home for
-- every agent dispatch this milestone creates. T7 (packages/agents/src/
-- runtime.ts) writes to these through a RunStore; T10 puts that RunStore on
-- top of this schema.
--
-- All three are workspace-owned per ADR-007: workspace_id NOT NULL, RLS
-- ENABLED and FORCED, and a policy carrying both USING and WITH CHECK so
-- smos_app can neither read nor write across a tenant boundary
-- (0001_core_tenancy.sql's pattern, repeated by every table since).
--
-- agent_run.agent_version_id -> agent_version and agent_run.campaign_id ->
-- campaign are both composite foreign keys on (id, workspace_id) --
-- 0008_composite_tenant_fk.sql's pattern, continued by 0012_agent_registry.sql
-- for agent_version.agent_definition_id: PostgreSQL evaluates a foreign key
-- against its referenced table with RLS bypassed entirely, so a
-- single-column FK would only prove that *some* row with that id exists
-- anywhere in the database, never that it belongs to the same workspace as
-- the child row referencing it. Deliberately no plain `REFERENCES
-- agent_version(id)` / `REFERENCES campaign(id)` anywhere on these columns
-- for that reason -- the composite FKs at the bottom of the agent_run
-- definition are what actually enforce the reference.
--
-- agent_version has no UNIQUE (id, workspace_id) yet: 0012_agent_registry.sql
-- never needed one, since nothing referenced agent_version compositely
-- before this migration. Added here, forward-only (0012 is applied and is
-- never edited), before agent_run's own composite FK to it is declared.
-- campaign already carries UNIQUE (id, workspace_id) from
-- 0008_composite_tenant_fk.sql.
ALTER TABLE agent_version ADD CONSTRAINT agent_version_id_workspace_id_key UNIQUE (id, workspace_id);

-- tool_call.agent_run_id and run_checkpoint.agent_run_id both reference
-- agent_run compositely for the identical reason, so agent_run gets its own
-- UNIQUE (id, workspace_id) below for those two children to target.
--
-- Text CHECKs use `x ~ '\S'`, never `btrim(...)`
-- (0009_check_whitespace_hardening.sql): PostgreSQL's single-argument
-- btrim() strips only ASCII spaces and lets a value made solely of
-- tabs/newlines through.
CREATE TABLE IF NOT EXISTS agent_run (
  id               uuid PRIMARY KEY,
  workspace_id     uuid NOT NULL REFERENCES workspace(id),
  agent_version_id uuid NOT NULL,
  campaign_id      uuid NOT NULL,
  state            text NOT NULL CHECK (state IN
                     ('pending', 'running', 'succeeded', 'failed_retryable', 'failed_terminal', 'cancelled')),
  cost_usd         numeric(10,6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  tokens_in        integer NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out       integer NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  wallclock_ms     integer NOT NULL DEFAULT 0 CHECK (wallclock_ms >= 0),
  budget_exceeded  boolean NOT NULL DEFAULT false,
  prompt_version   text NOT NULL CHECK (prompt_version ~ '\S'),
  model_version    text NOT NULL CHECK (model_version ~ '\S'),
  correlation_id   uuid,
  error_code       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (agent_version_id, workspace_id) REFERENCES agent_version (id, workspace_id),
  FOREIGN KEY (campaign_id, workspace_id) REFERENCES campaign (id, workspace_id)
);
CREATE INDEX IF NOT EXISTS agent_run_ws_state_idx ON agent_run (workspace_id, state);
ALTER TABLE agent_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_run_tenant_isolation ON agent_run;
CREATE POLICY agent_run_tenant_isolation ON agent_run
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- tool_call: one row per tool invocation attempt a run makes, whether the
-- tool registry allowed it or refused it (`allowed`) -- T4's ToolRegistry /
-- T7's runtime record both, since a refused call is exactly the kind of
-- event an audit trail must not silently omit.
CREATE TABLE IF NOT EXISTS tool_call (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  agent_run_id uuid NOT NULL,
  tool_name    text NOT NULL CHECK (tool_name ~ '\S'),
  allowed      boolean NOT NULL,
  args         jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code   text,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_run_id, workspace_id) REFERENCES agent_run (id, workspace_id)
);
CREATE INDEX IF NOT EXISTS tool_call_run_idx ON tool_call (agent_run_id);
ALTER TABLE tool_call ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_call FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tool_call_tenant_isolation ON tool_call;
CREATE POLICY tool_call_tenant_isolation ON tool_call
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- run_checkpoint: T7's runtime.ts calls store.checkpoint(runId, step, blob)
-- at fixed points ("prompt_built", "model_returned", "output_parsed") --
-- UNIQUE (agent_run_id, step_name) makes a checkpoint step idempotent per
-- run rather than silently accumulating duplicates on retry.
CREATE TABLE IF NOT EXISTS run_checkpoint (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  agent_run_id uuid NOT NULL,
  step_name    text NOT NULL CHECK (step_name ~ '\S'),
  state_blob   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_run_id, step_name),
  FOREIGN KEY (agent_run_id, workspace_id) REFERENCES agent_run (id, workspace_id)
);
ALTER TABLE run_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_checkpoint FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS run_checkpoint_tenant_isolation ON run_checkpoint;
CREATE POLICY run_checkpoint_tenant_isolation ON run_checkpoint
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- No DELETE grant, matching every other workspace-owned table's runtime
-- grant list (e.g. 0004_campaign.sql, 0012_agent_registry.sql): smos_app
-- reads, inserts and updates run bookkeeping but never deletes it. Test
-- cleanup that needs to remove rows created by smos_app-scoped inserts goes
-- through DATABASE_MIGRATION_URL (the smos role), same as every other
-- integration test in packages/db/src.
GRANT SELECT, INSERT, UPDATE ON agent_run, tool_call, run_checkpoint TO smos_app;
