-- Application role. Deliberately NOT superuser and NOT BYPASSRLS (ADR-007).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smos_app') THEN
    CREATE ROLE smos_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS workspace (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_account (
  id          uuid PRIMARY KEY,
  email       text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspace(id),
  event_type     text NOT NULL,
  actor_kind     text NOT NULL CHECK (actor_kind IN ('user','agent','system')),
  actor_user_id  uuid REFERENCES user_account(id),
  actor_run_id   uuid,
  subject_type   text,
  subject_id     uuid,
  correlation_id uuid,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_ws_time_idx ON audit_log (workspace_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_subject_idx ON audit_log (workspace_id, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS audit_log_correlation_idx ON audit_log (workspace_id, correlation_id);

-- Append-only. Two independent mechanisms so revoking one is not enough.
CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only; % is not permitted', TG_OP;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_mutation ON audit_log;
CREATE TRIGGER audit_log_no_mutation
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_tenant_isolation ON audit_log;
CREATE POLICY audit_log_tenant_isolation ON audit_log
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

GRANT USAGE ON SCHEMA public TO smos_app;
GRANT SELECT, INSERT ON audit_log TO smos_app;
REVOKE UPDATE, DELETE ON audit_log FROM smos_app;
GRANT SELECT ON workspace, user_account TO smos_app;
