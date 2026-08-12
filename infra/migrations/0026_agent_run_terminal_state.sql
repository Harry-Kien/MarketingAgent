-- Task 7 fix round 1, IMPORTANT finding 3: "no terminal state is actually
-- terminal." Reproduced live (packages/db/src/agent-run-terminal-state.test.ts,
-- run before this migration existed): `UPDATE agent_run SET state='running'`
-- on a run already `state='succeeded'` succeeds as smos_app, no error --
-- and so does moving it to a DIFFERENT terminal state (e.g. 'succeeded' ->
-- 'cancelled'). Nothing in 0024_agent_run.sql (applied, never edited) or
-- any later migration constrained which transitions of agent_run.state are
-- legal, only which VALUES are legal (the CHECK). TypeScript-only
-- enforcement has already been defeated by direct SQL as smos_app three
-- times in P1 (0007's approval actor, 0011's publication immutability,
-- 0013's activation gate); this closes the same class of hole for
-- agent_run.state.
--
-- Same shape as 0019_campaign_state_transition_guard.sql /
-- 0023_campaign_state_noop_update.sql for campaign.state: a BEFORE UPDATE
-- OF state trigger. Unlike campaign's full transition graph, agent_run has
-- no documented multi-step lifecycle to mirror (T7's runtime.ts only ever
-- writes 'running' at creation and one of 'succeeded' / 'failed_terminal'
-- at the end) -- the specific, reproduced bug is only about terminal states
-- being reversible, so that is the only rule this trigger enforces:
--
--   - NEW.state = OLD.state is always a no-op and allowed, even for an
--     already-terminal run -- matching 0023's own fix, so a future
--     full-row UPDATE that names `state` unchanged while changing some
--     other column (e.g. a later cost reconciliation) is never mistaken
--     for an illegal re-entry attempt.
--   - once OLD.state is 'succeeded', 'failed_terminal' or 'cancelled', any
--     OTHER target is refused -- including a different terminal state,
--     which the bug report explicitly asked to be checked. 'pending',
--     'running' and 'failed_retryable' remain unrestricted: nothing here
--     stops normal, legitimate progress through the non-terminal states.
CREATE OR REPLACE FUNCTION agent_run_terminal_state_is_terminal() RETURNS trigger AS $$
BEGIN
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  IF OLD.state IN ('succeeded', 'failed_terminal', 'cancelled') THEN
    RAISE EXCEPTION
      'agent_run % -> % is not allowed: % is a terminal state and cannot be re-entered or left, including to another terminal state',
      OLD.state, NEW.state, OLD.state;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS agent_run_terminal_state_is_terminal ON agent_run;
CREATE TRIGGER agent_run_terminal_state_is_terminal
  BEFORE UPDATE OF state ON agent_run
  FOR EACH ROW
  EXECUTE FUNCTION agent_run_terminal_state_is_terminal();
