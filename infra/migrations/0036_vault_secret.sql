-- Credential vault, Task: envelope encryption at rest.
--
-- THE PROBLEM THIS CLOSES: credential_reference.vault_key
-- (0028_integration.sql) is an opaque "vault://<workspace>/<slug>" pointer
-- that nothing has ever resolved -- the design deliberately deferred the
-- vault itself. This migration is that vault's storage: one row per secret,
-- holding CIPHERTEXT only, never plaintext, and a wrapped data key rather
-- than a raw one.
--
-- ENVELOPE ENCRYPTION SHAPE (packages/vault/src/envelope.ts implements the
-- crypto; this table is only where the two ciphertexts land):
--   secret plaintext --AES-256-GCM(random DATA KEY)--> ciphertext, iv, auth_tag
--   data key         --AES-256-GCM(KEY-ENCRYPTION KEY)--> wrapped_data_key, wrap_iv, wrap_auth_tag
-- The key-encryption key (KEK) itself is NEVER a column on this table, or
-- anywhere else in this database: packages/vault's KmsProvider interface
-- holds it (local dev: process environment via
-- packages/vault/src/providers/env-kms-provider.ts; production: a real KMS
-- implementing the same interface). A KEK stored beside the ciphertext it
-- protects buys nothing against the one actor who already has full SQL
-- access to this database -- see that package's header for exactly what
-- placing the KEK outside the database does, and does not, defend against.
--
-- kek_id is the KEK's VERSION, not the KEK itself -- rotation
-- (packages/vault/src/vault-store.ts's rotateSecretKek) re-wraps
-- wrapped_data_key/wrap_iv/wrap_auth_tag/kek_id under a new KEK version and
-- leaves ciphertext/iv/auth_tag untouched, so a compromised KEK can be
-- retired without ever touching (or needing) the original plaintext again.
-- The trigger below is the database backstop that makes "rotation only
-- re-wraps the data key" a fact about the table, not a TypeScript
-- convention -- this project's own governing failure mode, repeated across
-- P1 and P4, is exactly an invariant that lived only in application code and
-- was defeated by direct SQL as smos_app.
--
-- PRIVILEGE MODEL, the actual backstop for "smos_app must never reach a
-- plaintext secret, and ideally never the ciphertext either": smos_app gets
-- NO grant on this table at all -- not SELECT, not INSERT, not UPDATE, not
-- DELETE. Only a new, separate, narrow role -- smos_vault -- may touch it,
-- and only packages/vault ever connects as smos_vault (DATABASE_VAULT_URL,
-- its own credential, exactly like smos_worker's own credential for
-- outbox_claim_batch, 0017_outbox_claim_token.sql). This is the opposite
-- relationship from smos_worker: smos_worker is GRANTed smos_app's
-- privileges PLUS more, because the worker must do everything the app does.
-- smos_vault inherits nothing from smos_app and smos_app inherits nothing
-- from it -- two disjoint credentials, so a leaked DATABASE_URL (smos_app)
-- cannot reach this table by any SQL whatsoever, and a leaked
-- DATABASE_VAULT_URL (smos_vault) cannot reach anything else this
-- application owns. packages/db/src/cross-tenant.test.ts's exhaustive,
-- catalog-driven suite is taught about this table's deliberately different
-- shape (NO_APP_ACCESS_TABLES) in the same commit, per that file's own rule
-- that a workspace-owned table discovered by the catalog must be accounted
-- for explicitly, never silently skipped.
--
-- RLS stays ENABLED and FORCED even though smos_vault is the only role that
-- can reach this table at all: defence in depth per ADR-007's own
-- reasoning -- if packages/vault's own SQL ever has a bug and omits a
-- workspace_id filter, PostgreSQL still refuses to let smos_vault's session
-- see or write a row scoped to a different workspace's app.workspace_id
-- setting, exactly as it does for smos_app on every other table.
--
-- Text CHECKs use `x ~ '\S'`, never `btrim(...)`
-- (0009_check_whitespace_hardening.sql).

CREATE TABLE IF NOT EXISTS vault_secret (
  id                uuid PRIMARY KEY,
  workspace_id      uuid NOT NULL REFERENCES workspace(id),
  slug              text NOT NULL CHECK (slug ~ '\S'),
  -- Pinned to the one algorithm this vault speaks today. A future second
  -- algorithm is a forward migration (widen the CHECK, teach envelope.ts to
  -- read both), never a silent change to what this column accepts.
  algorithm         text NOT NULL DEFAULT 'aes-256-gcm' CHECK (algorithm = 'aes-256-gcm'),
  ciphertext        bytea NOT NULL,
  iv                bytea NOT NULL,
  auth_tag          bytea NOT NULL,
  wrapped_data_key  bytea NOT NULL,
  wrap_iv           bytea NOT NULL,
  wrap_auth_tag     bytea NOT NULL,
  kek_id            text NOT NULL CHECK (kek_id ~ '\S'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  rotated_at        timestamptz,
  UNIQUE (workspace_id, slug)
);
ALTER TABLE vault_secret ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_secret FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vault_secret_tenant_isolation ON vault_secret;
CREATE POLICY vault_secret_tenant_isolation ON vault_secret
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- Rotation-only backstop: an UPDATE may change wrapped_data_key, wrap_iv,
-- wrap_auth_tag, kek_id and rotated_at (re-wrapping under a new KEK version)
-- and NOTHING else. ciphertext/iv/auth_tag (the actual encrypted secret) and
-- id/workspace_id/slug/created_at (identity) are frozen from the moment a
-- row is inserted. Same to_jsonb-minus-exempt-columns technique as
-- 0027_agent_run_immutable_when_terminal.sql, inverted: there the exempt set
-- is what's allowed to keep moving on an otherwise-frozen row; here it is
-- the same idea applied to a table whose only legitimate post-insert write
-- is rotation.
CREATE OR REPLACE FUNCTION vault_secret_rotation_only() RETURNS trigger AS $$
DECLARE
  old_frozen jsonb;
  new_frozen jsonb;
BEGIN
  old_frozen := to_jsonb(OLD) - ARRAY['wrapped_data_key', 'wrap_iv', 'wrap_auth_tag', 'kek_id', 'rotated_at'];
  new_frozen := to_jsonb(NEW) - ARRAY['wrapped_data_key', 'wrap_iv', 'wrap_auth_tag', 'kek_id', 'rotated_at'];
  IF old_frozen IS DISTINCT FROM new_frozen THEN
    RAISE EXCEPTION
      'vault_secret %: only the wrapped data key (wrapped_data_key, wrap_iv, wrap_auth_tag, kek_id, rotated_at) may change on UPDATE -- rotation re-wraps the data key, it never re-encrypts the secret',
      OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS vault_secret_rotation_only ON vault_secret;
CREATE TRIGGER vault_secret_rotation_only
  BEFORE UPDATE ON vault_secret
  FOR EACH ROW EXECUTE FUNCTION vault_secret_rotation_only();

-- smos_vault: a new, narrow, separate login role. Deliberately NOT a member
-- of smos_app and NOT granted to it either -- see this file's header for why
-- that separation, not RLS, is what actually keeps smos_app from ever
-- reaching a row here.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smos_vault') THEN
    CREATE ROLE smos_vault NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE ON vault_secret TO smos_vault;
-- No password is set here -- npm run lint:secrets forbids a credential in
-- any migration file. scripts/apply-migrations.mjs sets it afterwards from
-- SMOS_VAULT_PASSWORD, the same pattern as 0002 (smos_app) and 0017
-- (smos_worker).
ALTER ROLE smos_vault LOGIN NOSUPERUSER NOBYPASSRLS;

-- Explicit and defensive, not load-bearing on its own (smos_app was never
-- granted anything on this table in the first place -- CREATE TABLE grants
-- nothing to PUBLIC or to any other role by default): states the intent in
-- a form packages/vault/src/vault-store.test.ts and
-- packages/db/src/cross-tenant.test.ts can both assert against directly via
-- information_schema.role_table_grants, and survives a future migration
-- that widens smos_app's privileges some other way without anyone having to
-- remember this table is the one exception.
REVOKE ALL ON vault_secret FROM smos_app;
REVOKE ALL ON vault_secret FROM PUBLIC;
