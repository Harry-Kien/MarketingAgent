-- Task 6: campaign aggregate. `goal` is the minimal parent campaign needs
-- (a workspace-scoped statement of intent); nothing here is a full Goal
-- aggregate for a later task. Both tables are workspace-owned per ADR-007:
-- workspace_id NOT NULL, RLS ENABLED and FORCED, and a policy carrying both
-- USING and WITH CHECK so smos_app can neither read nor write across a
-- tenant boundary.
CREATE TABLE IF NOT EXISTS goal (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  statement    text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE goal ENABLE ROW LEVEL SECURITY;
ALTER TABLE goal FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS goal_tenant_isolation ON goal;
CREATE POLICY goal_tenant_isolation ON goal
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE TABLE IF NOT EXISTS campaign (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  goal_id      uuid NOT NULL REFERENCES goal(id),
  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  state        text NOT NULL,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaign_ws_state_idx ON campaign (workspace_id, state);
ALTER TABLE campaign ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS campaign_tenant_isolation ON campaign;
CREATE POLICY campaign_tenant_isolation ON campaign
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON goal, campaign TO smos_app;
