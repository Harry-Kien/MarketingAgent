-- Task 8: approval integrity enforced by the database (E3, E4). This is the
-- single claim this milestone most needs to be able to defend: it must be
-- structurally impossible for an AI agent to approve its own work, not
-- merely unlikely or blocked in the UI.
--
-- Both tables are workspace-owned per ADR-007: workspace_id NOT NULL, RLS
-- ENABLED and FORCED, and a policy carrying both USING and WITH CHECK so
-- smos_app can neither read nor write across a tenant boundary.
CREATE TABLE IF NOT EXISTS approval_request (
  id                 uuid PRIMARY KEY,
  workspace_id       uuid NOT NULL REFERENCES workspace(id),
  campaign_id        uuid NOT NULL REFERENCES campaign(id),
  content_version_id uuid NOT NULL REFERENCES content_version(id),
  target_channel     text NOT NULL CHECK (length(btrim(target_channel)) > 0),
  policy_flags       jsonb NOT NULL DEFAULT '[]'::jsonb,
  estimated_impact   text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE approval_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_request FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_request_tenant_isolation ON approval_request;
CREATE POLICY approval_request_tenant_isolation ON approval_request
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- E4: the actor must be a real user row. An agent has no user_account row,
-- so an agent literally cannot satisfy this foreign key -- this is the
-- primary lock. actor_kind is a second, independent lock: it agrees with
-- Task 3's domain rule (packages/domain/src/approval.ts, decideApproval)
-- that APPROVED requires a *user* actor -- agent AND system actors are both
-- refused, not merely agent actors -- so the CHECK pins the column to
-- 'user' outright rather than merely excluding 'agent'. Either lock alone
-- is verified in packages/db/src/approval-invariants.test.ts to stop an
-- agent; neither is trusted to be sufficient alone.
CREATE TABLE IF NOT EXISTS approval_decision (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES workspace(id),
  approval_request_id uuid NOT NULL UNIQUE REFERENCES approval_request(id),
  actor_user_id       uuid NOT NULL REFERENCES user_account(id),
  actor_kind          text NOT NULL DEFAULT 'user' CHECK (actor_kind = 'user'),
  decision            text NOT NULL CHECK (decision IN ('approve','reject','request_changes')),
  reason              text NOT NULL CHECK (length(btrim(reason)) > 0),
  decided_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE approval_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_decision FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_decision_tenant_isolation ON approval_decision;
CREATE POLICY approval_decision_tenant_isolation ON approval_decision
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- Approval decisions are a record of a human act; they are never edited.
-- Two independent mechanisms (trigger + revoked grants), same pattern as
-- audit_log in 0001_core_tenancy.sql, so revoking one is not enough.
CREATE OR REPLACE FUNCTION approval_decision_is_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'approval_decision is immutable; % is not permitted', TG_OP;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS approval_decision_no_mutation ON approval_decision;
CREATE TRIGGER approval_decision_no_mutation
  BEFORE UPDATE OR DELETE ON approval_decision
  FOR EACH ROW EXECUTE FUNCTION approval_decision_is_immutable();

GRANT SELECT, INSERT ON approval_request, approval_decision TO smos_app;
REVOKE UPDATE, DELETE ON approval_decision FROM smos_app;
GRANT UPDATE ON approval_request TO smos_app;
