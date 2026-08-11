-- Final whole-branch review, round 2, RESIDUAL HIGH on finding 1.
-- `ALTER FUNCTION ... SET search_path = public` (0018) does not close the
-- decoy-table class of attack completely: PostgreSQL implicitly searches
-- `pg_temp` (the calling session's own temporary schema) BEFORE anything in
-- the configured search_path, for every unqualified relation reference,
-- regardless of what search_path is set to. Reproduced live, on a freshly
-- migrated database, as plain smos_app, with no CREATE ON DATABASE, no
-- schema ownership and no `SET search_path` call at all:
--
--   CREATE TEMP TABLE agent_definition(id uuid, workspace_id uuid, role text);
--   INSERT INTO agent_definition VALUES (<real def id>, <ws>, 'content');
--   INSERT INTO agent_version(..., activated) VALUES (..., true);   -- succeeds
--
-- Same result as 0018's named-schema attack (activated = t on
-- integration_reliability), just via a schema `SET search_path` can never
-- exclude. The standard, complete fix for this class is to schema-qualify
-- every unqualified relation reference INSIDE the function body itself
-- (`public.agent_definition`, `public.outbox`) rather than relying on
-- search_path alone -- a qualified reference resolves directly to the named
-- schema and is never subject to pg_temp's (or any schema's) implicit
-- precedence. `SET search_path = public` (0018) is kept as belt and braces:
-- it is what stops the named-schema variant (0018's own test), and costs
-- nothing to leave in place now that the qualification below is the actual
-- load-bearing fix for both variants.
--
-- Applied to every function in this branch that names a table unqualified
-- in its body -- audited by re-reading all seven functions from the 0018
-- audit. Three qualify a table by name; four do not and are therefore
-- unaffected by this class of attack (they only RAISE EXCEPTION using
-- TG_OP/TG_ARGV, never a table lookup) and are not touched here:
--
--   agent_version_m1_activation_gate()        -- FROM agent_definition -> FROM public.agent_definition
--   outbox_claim_batch(integer)                -- FROM/UPDATE outbox    -> FROM/UPDATE public.outbox
--   outbox_mark_published(uuid, uuid)          -- UPDATE outbox         -> UPDATE public.outbox
--   audit_log_is_append_only()                 -- no table reference, untouched
--   approval_decision_is_immutable()           -- no table reference, untouched
--   publication_core_fields_immutable()        -- no table reference, untouched
--   agent_definition_role_immutable()          -- no table reference, untouched
--   campaign_validate_state_transition()       -- no table reference (0019; reads only NEW/OLD), untouched
--
-- outbox_claim_batch's `RETURNS SETOF outbox` and outbox_mark_published's
-- parameter/return types are NOT touched: a function's declared signature
-- is resolved once, at CREATE/REPLACE time (here, always run by the
-- migration-owner role with no attacker-controlled temp table in
-- existence), and bound to a fixed type OID from then on -- immune to any
-- later session's search_path or pg_temp, the same way CHECK constraints
-- and RLS policies already were (0018's own note). Only the relation
-- lookups actually re-evaluated at call time (FROM/UPDATE targets) needed
-- qualifying.
--
-- CREATE OR REPLACE with an unchanged signature preserves the function's
-- OID, so every existing GRANT/REVOKE, OWNER and trigger attachment
-- (agent_version_m1_activation_gate's trigger; outbox_claim_batch/
-- outbox_mark_published's ownership by smos_outbox_drainer and EXECUTE
-- grants to smos_worker) carries over automatically -- none of that is
-- restated here. Idempotent: CREATE OR REPLACE unconditionally re-applies
-- the same body on every run.

CREATE OR REPLACE FUNCTION agent_version_m1_activation_gate() RETURNS trigger AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role
  FROM public.agent_definition
  WHERE id = NEW.agent_definition_id AND workspace_id = NEW.workspace_id;

  IF v_role IS NULL THEN
    RAISE EXCEPTION
      'agent_version.agent_definition_id % has no matching agent_definition row in workspace %',
      NEW.agent_definition_id, NEW.workspace_id;
  END IF;

  IF v_role NOT IN ('orchestrator', 'research', 'content', 'qa_brand_safety') THEN
    RAISE EXCEPTION
      'agent_version cannot be activated for role %: only orchestrator, research, content and qa_brand_safety are activated in M1 (M1_ACTIVATED_AGENTS, packages/domain/src/agent-registry.ts). Activating a fifth agent is a deliberate forward migration, not a code edit.',
      v_role;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE OR REPLACE FUNCTION outbox_claim_batch(p_batch_size integer)
RETURNS SETOF outbox
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH token AS (
    SELECT gen_random_uuid() AS claim_token
  ), candidates AS (
    SELECT id FROM public.outbox
    WHERE published_at IS NULL
    ORDER BY created_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.outbox
  SET claimed_by = token.claim_token, claimed_at = now()
  FROM candidates, token
  WHERE outbox.id = candidates.id
  RETURNING outbox.*;
$$;

CREATE OR REPLACE FUNCTION outbox_mark_published(p_id uuid, p_claimed_by uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH updated AS (
    UPDATE public.outbox
    SET published_at = now()
    WHERE id = p_id AND claimed_by = p_claimed_by AND published_at IS NULL
    RETURNING id
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;
