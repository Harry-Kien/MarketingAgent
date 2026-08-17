-- Final whole-branch review, IMPORTANT 5 ("identity has no tenancy") and
-- IMPORTANT 4 ("0030 guards the front door only").
--
-- 0029_auth_schema.sql made a table-by-table tenancy decision and wrote it
-- down honestly, but it stopped at "does this table carry a workspace_id".
-- For the four global tables the answer was no -- correctly -- and then
-- nothing else was done, so "not workspace-owned" silently became "not
-- protected at all". Measured live on this database before this migration:
--
--   workspace     relrowsecurity = false; smos_app read all 862 rows
--   user_account  relrowsecurity = false; smos_app read all 1058 rows
--   session       SELECT/INSERT/UPDATE/DELETE to smos_app, no RLS
--   account       same, including the `password` column
--   verification  same
--   resolve_user_workspace  SECURITY DEFINER, superuser-owned, EXECUTE to PUBLIC
--
-- Minting a session row for any user succeeded as smos_app. Overwriting a
-- stored password hash succeeded. Reading every password hash in the system
-- succeeded. Combined with CRITICAL 2 (0037) that was a complete
-- authentication bypass from a single SQL connection.
--
-- THE DECISION, TABLE BY TABLE. "Give it a workspace_id like everything
-- else" is wrong for every table here, and each is wrong for its own
-- reason. Tenancy is not one mechanism; it is the question "who may see
-- this row", answered per table.
--
--   workspace       -- SCOPED TO ITSELF. It has no workspace_id column
--                      because its own `id` IS the tenancy column: the row
--                      is the tenant. RLS ENABLED and FORCED, with a SELECT
--                      policy `id = current_setting('app.workspace_id')`.
--                      A session scoped to workspace A now sees exactly one
--                      workspace row -- its own -- instead of the entire
--                      customer list. smos_app has no UPDATE and no DELETE
--                      here (0001 never granted them), so an existing
--                      workspace can be neither renamed nor removed by the
--                      application role.
--
--                      INSERT is kept, under its own explicit policy, and
--                      this is the one deliberate asymmetry in this file.
--                      A workspace row is the only row in the schema that
--                      cannot pre-exist the scope named after it -- there is
--                      no `app.workspace_id` to check a new workspace's id
--                      against, because that id is what is being created --
--                      so a WITH CHECK referencing the current scope would
--                      make workspace creation impossible rather than
--                      merely administrative. It leaks nothing: the creator
--                      cannot read the row back except by scoping to it,
--                      the row carries no other tenant's data, and every
--                      table hanging off it stays RLS-isolated exactly as
--                      before. What it does still permit is an application
--                      role creating junk tenants of its own -- a storage
--                      concern, not a confidentiality one. Making
--                      provisioning administrative (REVOKE INSERT, as 0030
--                      did for user_account) is the stricter end state and
--                      is deliberately NOT bundled here: ~22 test files
--                      currently seed their workspace through the smos_app
--                      pool, and moving all of them belongs in its own
--                      change rather than riding along with a security fix.
--
--   user_account    -- MEMBERSHIP-DERIVED, never a workspace_id column. The
--                      brief's own constraint: "a user legitimately may
--                      belong to several workspaces, so blanket workspace_id
--                      is wrong." Stamping one on would make that case
--                      unrepresentable -- the same human would need one row
--                      per workspace, and approval_decision.actor_user_id
--                      would then reference one of several copies of them.
--                      So the row stays global and its VISIBILITY is derived
--                      from workspace_member instead: smos_app, scoped to
--                      workspace W, sees exactly the users who hold a
--                      membership row in W. That is the same question
--                      0037's composite foreign key answers on the write
--                      side, now answered on the read side too, from the
--                      same single source of truth.
--
--                      The policy is declared TO smos_app specifically, not
--                      to everyone: smos_auth (below) must be able to look a
--                      user up by email BEFORE any workspace is known -- that
--                      is what signing in IS -- so it gets its own,
--                      separate, read-only policy. Naming the roles makes
--                      the two different answers explicit instead of hiding
--                      them in one expression. smos_worker inherits
--                      smos_app's membership and is therefore covered by
--                      smos_app's policy automatically.
--
--   session         -- GLOBAL, and NOT smos_app's to touch. 0029's reasoning
--   account            for why these three carry no workspace_id is still
--   verification       right and is not disturbed: a session authenticates a
--                      USER, a credential belongs to a USER, a verification
--                      token identifies a USER (or a bare email during
--                      sign-up) -- none of them is workspace data, and
--                      giving them a workspace_id is what would let a
--                      session claim its own tenancy instead of having it
--                      looked up server-side. Their tenancy answer is
--                      therefore not RLS but PRIVILEGE SEPARATION, the same
--                      shape 0036_vault_secret.sql used for vault_secret:
--                      a separate, narrow login role -- smos_auth -- owns
--                      the authentication surface, and smos_app loses every
--                      grant on all three tables outright.
--
--                      This is what actually closes the forged-session and
--                      password-overwrite attacks. RLS could not have: the
--                      legitimate INSERT into session happens right after a
--                      password is verified in application code, and no
--                      row-level predicate can tell that INSERT apart from a
--                      forged one. What CAN tell them apart is which
--                      credential issued it. better-auth's pool is the only
--                      thing that ever connects as smos_auth
--                      (DATABASE_AUTH_URL, apps/web/src/server/db.ts's
--                      getAuthPool), exactly like packages/vault is the only
--                      thing that connects as smos_vault. smos_auth is NOT a
--                      member of smos_app and smos_app is NOT a member of
--                      smos_auth -- two disjoint credentials, so a leaked
--                      DATABASE_URL cannot mint a session by any SQL
--                      whatsoever, and a leaked DATABASE_AUTH_URL cannot
--                      read or write one row of this application's own data.
--
--                      smos_auth gets SELECT on account and NOT
--                      INSERT/UPDATE/DELETE: verifying a password requires
--                      reading the hash, and nothing else. Sign-up is
--                      unreachable through the running app
--                      (emailAndPassword.disableSignUp, 0030's reasoning)
--                      and password change is not implemented, so enabling
--                      either is a forward migration, not a grant sitting
--                      there in advance.
--
--   workspace_member -- unchanged here. Already workspace-owned with RLS
--                      ENABLED and FORCED since 0029, and made
--                      administrative-write-only by 0037.
--
-- resolve_user_workspace: EXECUTE is REVOKEd from PUBLIC. The function is
-- SECURITY DEFINER, owned by the migration role (a superuser), and its
-- entire purpose is to bypass workspace_member's RLS for the one bootstrap
-- question the application cannot ask any other way. Who may call it at all
-- is therefore its only boundary, and `GRANT ... TO PUBLIC` handed that
-- boundary to every role in the cluster, present and future -- including
-- smos_vault and smos_auth, neither of which has any business mapping users
-- to workspaces. smos_app keeps its explicit grant (0029), which is what
-- apps/web/src/server/auth-core.ts's lookupWorkspace uses.
--
-- Text CHECKs, function hardening and schema qualification conventions:
-- 0009/0018/0022, unchanged.

-- ---------------------------------------------------------------------------
-- workspace: scoped to itself
-- ---------------------------------------------------------------------------
ALTER TABLE workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_self_scope ON workspace;
CREATE POLICY workspace_self_scope ON workspace
  FOR SELECT
  USING (id = current_setting('app.workspace_id', true)::uuid);

DROP POLICY IF EXISTS workspace_provisioning ON workspace;
CREATE POLICY workspace_provisioning ON workspace
  FOR INSERT
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- user_account: visible to the application only through membership
-- ---------------------------------------------------------------------------
ALTER TABLE user_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_account FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_account_workspace_members ON user_account;
CREATE POLICY user_account_workspace_members ON user_account
  FOR SELECT
  TO smos_app
  USING (EXISTS (
    SELECT 1 FROM public.workspace_member m
     WHERE m.user_id = user_account.id
       AND m.workspace_id = current_setting('app.workspace_id', true)::uuid
  ));

-- ---------------------------------------------------------------------------
-- smos_auth: the separate credential that owns the authentication surface
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smos_auth') THEN
    CREATE ROLE smos_auth NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

DROP POLICY IF EXISTS user_account_auth_surface ON user_account;
CREATE POLICY user_account_auth_surface ON user_account
  FOR SELECT
  TO smos_auth
  USING (true);

GRANT SELECT ON user_account TO smos_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON session TO smos_auth;
GRANT SELECT ON account TO smos_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON verification TO smos_auth;

-- No password is set here -- npm run lint:secrets forbids a credential in any
-- migration file. scripts/apply-migrations.mjs sets it afterwards from
-- SMOS_AUTH_PASSWORD, the same pattern as 0002 (smos_app), 0017
-- (smos_worker) and 0036 (smos_vault).
ALTER ROLE smos_auth LOGIN NOSUPERUSER NOBYPASSRLS;

-- ---------------------------------------------------------------------------
-- smos_app loses the authentication tables entirely
-- ---------------------------------------------------------------------------
REVOKE ALL ON session, account, verification FROM smos_app;
REVOKE ALL ON session, account, verification FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION resolve_user_workspace(uuid) FROM PUBLIC;
