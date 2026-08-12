-- Task 7 fix round 2, IMPORTANT: 0026_agent_run_terminal_state.sql
-- (applied, never edited) declared its trigger `BEFORE UPDATE OF state` --
-- it only fires when an UPDATE's SET clause actually names `state`.
-- Reproduced live as smos_app, on a run already `state='succeeded'`:
--
--   update agent_run set cost_usd=999, tokens_out=999, error_code='rewritten'
--
-- was ACCEPTED outright. Every audit column fix round 1 just started
-- writing correctly for the first time -- tokens_in, tokens_out,
-- wallclock_ms, model_version, cost_usd, error_code -- was therefore freely
-- rewritable the instant a run reached a terminal state, with nothing
-- enforcing otherwise. A terminal agent_run is an audit record of what
-- actually happened, not merely a state machine that stopped moving --
-- exactly the principle P1 already applied to approval_decision (0007:
-- whole-row immutable, "a record of a human act") and publication (0011:
-- column-selective, "a fixed record of specific text under a specific
-- approval"). agent_run sits between the two: unlike approval_decision it
-- has a real, legitimate PRE-terminal lifecycle (pending -> running ->
-- terminal, with cost/token accounting updated along the way by
-- checkpoints and the eventual finishRun call itself), so it cannot be
-- immutable unconditionally -- but once `state` first becomes terminal, it
-- should behave exactly like publication's frozen columns.
--
-- Rather than hand-enumerating a column list the way 0011 did for
-- publication -- which is exactly the shape of gap this finding proves
-- easy to under-scope, since the reviewer's own explicit list of six audit
-- columns would still have missed agent_version_id, campaign_id,
-- correlation_id and budget_exceeded -- this compares OLD and NEW as whole
-- rows via to_jsonb(), minus the one column that is deliberately exempt:
-- `updated_at`, which must keep moving so an idempotent re-write of the
-- SAME terminal outcome (0023's precedent for campaign.state, reused by
-- 0026 above: `succeeded -> succeeded` must still succeed) does not get
-- refused just because a timestamp moved. Any OTHER difference at all --
-- including, but no longer limited to, the state changes 0026 already
-- caught -- is refused. This naturally subsumes 0026's own
-- state-transition rule (a state change IS a row difference), so the
-- function 0026 created is REPLACED here (CREATE OR REPLACE, same name)
-- rather than left running alongside a second, wider check on the same
-- table -- 0026's own migration file is untouched, per this repo's
-- forward-only convention (0022 replaced 0013's function body the same
-- way).
--
-- The trigger declaration itself is widened from `BEFORE UPDATE OF state`
-- to a plain `BEFORE UPDATE` (fires on every UPDATE regardless of which
-- columns its SET clause names) -- `OF state` was precisely the gap this
-- finding exploited.
--
-- SET search_path = public per 0022's audit, same as every trigger
-- function this branch has added since.
CREATE OR REPLACE FUNCTION agent_run_terminal_state_is_terminal() RETURNS trigger AS $$
DECLARE
  old_frozen jsonb;
  new_frozen jsonb;
BEGIN
  IF OLD.state NOT IN ('succeeded', 'failed_terminal', 'cancelled') THEN
    RETURN NEW;
  END IF;

  old_frozen := to_jsonb(OLD) - 'updated_at';
  new_frozen := to_jsonb(NEW) - 'updated_at';

  IF old_frozen IS DISTINCT FROM new_frozen THEN
    RAISE EXCEPTION
      'agent_run % is terminal (%): a terminal run is an immutable audit record and may not be modified further, except updated_at',
      OLD.id, OLD.state;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS agent_run_terminal_state_is_terminal ON agent_run;
CREATE TRIGGER agent_run_terminal_state_is_terminal
  BEFORE UPDATE ON agent_run
  FOR EACH ROW
  EXECUTE FUNCTION agent_run_terminal_state_is_terminal();
