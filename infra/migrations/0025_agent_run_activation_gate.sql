-- Task 7 hard requirement (2): "the activation gate must be closed at the
-- database, not only in TypeScript." packages/domain/src/agent-registry.ts's
-- assertActivated (consumed by packages/agents/src/runtime.ts's runAgent) is
-- exactly the kind of TypeScript-only invariant P1 already learned, three
-- times over (0013, 0019, 0011), is defeated by a direct SQL write as
-- smos_app: 0024_agent_run.sql (applied, never edited) declares agent_run
-- with a composite FK to agent_version but nothing that inspects
-- agent_version.activated before accepting the insert. Reproduced live on
-- the pre-migration schema (packages/db/src/agent-run-activation-gate.test.ts,
-- run before this file existed): inserting an agent_run scoped to a real,
-- same-workspace, but activated=false agent_version succeeded with no error.
--
-- 0013_agent_version_activation_gate.sql already stops a *fifth role* from
-- ever being marked activated=true, which closes the "wrong role" half of
-- this gap. It does not close the other half: a legitimate M1 role
-- (orchestrator/research/content/qa_brand_safety) frequently has a version
-- that is not yet activated -- a draft awaiting activation, or one an
-- operator deliberately deactivated -- and nothing stopped an agent_run
-- from being recorded against THAT version regardless. A run for a
-- non-activated agent must be impossible to record, not merely impossible
-- to start through runAgent's happy path.
--
-- A BEFORE INSERT trigger looks up the referenced agent_version's
-- `activated` flag via the exact (agent_version_id, workspace_id) pair
-- agent_run's own composite FK already guarantees exists, and refuses the
-- row only when that lookup POSITIVELY finds a row with activated = false.
-- Deliberately NOT symmetrical with 0013's "raise on not-found" behaviour:
-- when the lookup finds nothing at all -- because the referenced version
-- genuinely does not exist, or (the case that matters here) because it
-- belongs to a *different* workspace and this table's own RLS policy hides
-- it from the lookup -- this trigger stays silent and lets the row fall
-- through to the checks that already exist and are already exercised by
-- packages/db/src/agent-run.test.ts and cross-tenant.test.ts: agent_run's
-- own tenant RLS policy (WITH CHECK) and the composite FK to agent_version.
-- An earlier version of this trigger also raised on "not found" and was
-- caught by those existing tests: a cross-workspace attack row's
-- agent_version_id/workspace_id pair never matches (the id belongs to one
-- workspace, the tag to another), so the lookup is NULL there too, and
-- raising this trigger's own generic message pre-empted the FK/RLS engine
-- before it produced the specific "row-level security"/"foreign key"
-- errors those tests correctly pin. Restricting this trigger to the one
-- case only IT can see -- a row that resolves, in-tenant, to a real but
-- deliberately non-activated version -- leaves every other rejection path
-- exactly as it already was.
--
-- Also fires on UPDATE OF agent_version_id, the only column an UPDATE could
-- use to re-point an existing run at a different (potentially
-- non-activated) version after the fact -- runtime.ts's own finishRun never
-- touches this column, but the trigger does not rely on that to hold
-- forever.
--
-- Schema-qualified (`public.agent_version`) and `SET search_path = public`,
-- per 0022_function_table_qualification.sql: an unqualified reference would
-- resolve against a session's own pg_temp schema before `public`, which
-- `SET search_path` alone cannot exclude -- exactly the decoy-table class
-- 0022 closed for the other trigger functions in this file's family. Runs as
-- the invoking role (smos_app, no SECURITY DEFINER), so its SELECT is
-- itself subject to agent_version's own RLS policy -- which is exactly what
-- makes the cross-workspace case above resolve to NULL rather than a false
-- positive.
CREATE OR REPLACE FUNCTION agent_run_requires_activated_agent() RETURNS trigger AS $$
DECLARE
  v_activated boolean;
BEGIN
  SELECT activated INTO v_activated
  FROM public.agent_version
  WHERE id = NEW.agent_version_id AND workspace_id = NEW.workspace_id;

  IF v_activated IS NOT NULL AND NOT v_activated THEN
    RAISE EXCEPTION
      'agent_run cannot be recorded for agent_version %: it is not activated. A run for a non-activated agent must be impossible to record, not merely impossible to start through assertActivated''s TypeScript-level gate (packages/domain/src/agent-registry.ts, packages/agents/src/runtime.ts).',
      NEW.agent_version_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS agent_run_requires_activated_agent ON agent_run;
CREATE TRIGGER agent_run_requires_activated_agent
  BEFORE INSERT OR UPDATE OF agent_version_id ON agent_run
  FOR EACH ROW
  EXECUTE FUNCTION agent_run_requires_activated_agent();
