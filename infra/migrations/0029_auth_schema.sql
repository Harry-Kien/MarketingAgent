-- Real authentication: better-auth 1.6.26's schema, adapted to this
-- project's tenancy invariants (ADR-007) rather than taken as-is.
--
-- Table-by-table tenancy decision, made deliberately rather than by
-- convenience (see the task brief's own instruction to decide this):
--
--   user_account  -- GLOBAL. Already existed (0001); this migration only
--                     adds the columns better-auth's "user" model needs
--                     (email_verified, image, updated_at). A user is not
--                     workspace-owned data: D1-7 keeps the door open to one
--                     person belonging to several workspaces later, and a
--                     row here carries no business data of any workspace.
--   session       -- GLOBAL. Already allowlisted in GLOBAL_TABLES
--                     (scripts/migration-guards.mjs) before this migration
--                     existed -- the table name and this exact tenancy
--                     decision were anticipated when that allowlist was
--                     written. A session authenticates a *user*, not a
--                     workspace; carrying no workspace_id is what makes it
--                     possible for `resolveWorkspace` (apps/web/src/server/
--                     session.ts) to look the workspace up from the userId
--                     server-side, rather than trust one embedded in the
--                     session itself.
--   account       -- GLOBAL, same reasoning as session: a credential
--                     (password hash) belongs to a user, not a workspace.
--   verification  -- GLOBAL: an email/password-reset token identifies a
--                     user (or a bare email during sign-up), never a
--                     workspace.
--   workspace_member -- WORKSPACE-OWNED. This is the actual multi-tenant
--                     membership edge D1-7 requires the schema to already
--                     have, even though Slice 1 seeds exactly one row here
--                     (single-workspace is a data state, not a code
--                     assumption). workspace_id NOT NULL, RLS ENABLED and
--                     FORCED, USING + WITH CHECK, exactly like every other
--                     workspace-owned table since 0001.
--
-- The bootstrap problem this creates, and its resolution: resolving WHICH
-- workspace a user belongs to has to run BEFORE `app.workspace_id` is set --
-- that is the very value being looked up -- so it cannot go through
-- `withTenant` like every other query in this codebase. A plain query
-- against workspace_member with no workspace scope set would read
-- current_setting('app.workspace_id', true) as NULL, and
-- `workspace_id = NULL` is never true, so RLS would silently return zero
-- rows even for the user's own membership. `resolve_user_workspace(uuid)`
-- below is a narrow, reviewed exception: a SECURITY DEFINER function owned
-- by the migration role (a superuser, so FORCE ROW LEVEL SECURITY does not
-- apply to it -- the same fact 0002_smos_app_login.sql's own header
-- documents), callable by smos_app, that answers exactly one question --
-- "which workspace does this specific user_id belong to" -- and nothing
-- else. It is safe only because every caller in this codebase supplies
-- p_user_id from the authenticated session's own userId
-- (apps/web/src/server/session.ts's `resolveWorkspace`), never from
-- anything client-supplied; ad-hoc application code that queries
-- workspace_member directly (not through this function) still gets
-- RLS-filtered, tenant-isolated results, proven in
-- packages/db/src/auth-schema.test.ts.
--
-- Text CHECKs use `x ~ '\S'`, never `btrim(...)` (0009_check_whitespace_
-- hardening.sql). Functions schema-qualify their table references
-- (0022_function_table_qualification.sql).

ALTER TABLE user_account ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;
ALTER TABLE user_account ADD COLUMN IF NOT EXISTS image text;
ALTER TABLE user_account ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- better-auth "session" model. No RLS: global table, see header.
CREATE TABLE IF NOT EXISTS session (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  token       text NOT NULL CHECK (token ~ '\S'),
  expires_at  timestamptz NOT NULL,
  ip_address  text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token)
);
CREATE INDEX IF NOT EXISTS session_user_id_idx ON session (user_id);

-- better-auth "account" model: one row per credential a user has (here,
-- exactly one email/password row per user, providerId = 'credential'). The
-- only column that can hold secret material is `password` (a hash, per
-- better-auth's own design -- never a plaintext value); there is no
-- separate secret store to point at here the way credential_reference
-- (0028_integration.sql) points at one for third-party integrations,
-- because a login credential is not workspace-owned data.
CREATE TABLE IF NOT EXISTS account (
  id                        uuid PRIMARY KEY,
  user_id                   uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  account_id                text NOT NULL CHECK (account_id ~ '\S'),
  provider_id               text NOT NULL CHECK (provider_id ~ '\S'),
  access_token              text,
  refresh_token             text,
  id_token                  text,
  access_token_expires_at   timestamptz,
  refresh_token_expires_at  timestamptz,
  scope                     text,
  password                  text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, account_id)
);
CREATE INDEX IF NOT EXISTS account_user_id_idx ON account (user_id);

CREATE TABLE IF NOT EXISTS verification (
  id          uuid PRIMARY KEY,
  identifier  text NOT NULL CHECK (identifier ~ '\S'),
  value       text NOT NULL CHECK (value ~ '\S'),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification (identifier);

-- workspace_member: WORKSPACE-OWNED, see header. This is the join D1-7
-- requires to exist even though Slice 1 seeds exactly one row here.
CREATE TABLE IF NOT EXISTS workspace_member (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  user_id      uuid NOT NULL REFERENCES user_account(id),
  role         text NOT NULL DEFAULT 'owner' CHECK (role ~ '\S'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);
ALTER TABLE workspace_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_member FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_member_tenant_isolation ON workspace_member;
CREATE POLICY workspace_member_tenant_isolation ON workspace_member
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- The bootstrap bridge: userId (trusted, from a verified session) in,
-- workspaceId out, RLS bypassed only inside this one narrow function body.
-- "First membership wins" (ORDER BY created_at ASC LIMIT 1) is a Slice-1
-- simplification consistent with single-workspace-first as a DATA state
-- (D1.a): today exactly one workspace_member row exists per user, so which
-- tiebreak rule is used is moot; a future multi-workspace UI picking among
-- several memberships is out of scope here (D1.b) and does not change this
-- function's contract of "one caller-trusted user_id in, at most one
-- workspace_id out."
CREATE OR REPLACE FUNCTION resolve_user_workspace(p_user_id uuid) RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT workspace_id
  FROM public.workspace_member
  WHERE user_id = p_user_id
  ORDER BY created_at ASC
  LIMIT 1;
$$;

GRANT INSERT, UPDATE ON user_account TO smos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON session, account, verification TO smos_app;
GRANT SELECT, INSERT, UPDATE ON workspace_member TO smos_app;
GRANT EXECUTE ON FUNCTION resolve_user_workspace(uuid) TO smos_app;
