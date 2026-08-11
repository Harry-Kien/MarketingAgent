-- Final whole-branch review, round 2. 0019_campaign_state_transition_guard.sql's
-- trigger fires on any UPDATE that names the `state` column and originally
-- raised on `NEW.state = OLD.state`, mirroring canTransition's own
-- from === to rule. But canTransition judges a REQUESTED transition; this
-- trigger instead fires on any UPDATE that merely NAMES state in its SET
-- clause, including one where state was never actually requested to
-- change. Nothing writes `campaign` today, but the first full-row UPDATE
-- from a real ORM or repository layer -- naming every column, most of them
-- unchanged, to update just one -- will include `state` in its SET clause
-- even when only (say) `name` is actually changing, and would have been
-- rejected outright with no real transition ever attempted.
--
-- Fix: treat NEW.state = OLD.state as a no-op and allow it (RETURN NEW
-- immediately), rather than raising. Checked first, before the terminal-
-- state check, so a full-row UPDATE that carries state unchanged succeeds
-- even for a campaign already in a terminal state -- correct, since this
-- trigger's whole job is judging requested transitions of state, and this
-- one requests none. A transition to a genuinely different, illegal target
-- state is still refused exactly as before; only the from === to case
-- changes.
--
-- Idempotent: CREATE OR REPLACE re-applies the same body on every run; the
-- trigger itself (BEFORE UPDATE OF state, no WHEN clause) is unchanged from
-- 0019 and is not re-declared here.
CREATE OR REPLACE FUNCTION campaign_validate_state_transition() RETURNS trigger AS $$
DECLARE
  main_states text[] := ARRAY[
    'DRAFT', 'RESEARCHING', 'PLANNED', 'IN_PROGRESS', 'INTERNAL_REVIEW',
    'WAITING_APPROVAL', 'APPROVED', 'SCHEDULED', 'EXECUTING', 'MEASURING',
    'COMPLETED'
  ];
  side_states text[] := ARRAY['BLOCKED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'CANCELLED'];
  from_idx int;
  to_idx int;
BEGIN
  -- Validity of the target value itself (is it one of the 15 real states at
  -- all) is campaign_state_valid's job (0005_campaign_state_check.sql), not
  -- this trigger's -- and that CHECK constraint runs after this BEFORE ROW
  -- trigger returns, with its own, more specific error message. If NEW.state
  -- is not a real state, defer to it entirely rather than raising a less
  -- specific "not allowed" here first; this trigger only judges legality of
  -- a transition BETWEEN two already-valid states.
  IF NOT (NEW.state = ANY(main_states) OR NEW.state = ANY(side_states)) THEN
    RETURN NEW;
  END IF;

  -- A no-op: this UPDATE's SET clause names `state`, but the value is
  -- unchanged. Allowed unconditionally -- including for a campaign already
  -- in a terminal state -- so a full-row UPDATE that changes some other
  -- column while carrying `state` unchanged in the same SET clause is not
  -- mistaken for a (illegal) same-state "transition".
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  IF OLD.state IN ('COMPLETED', 'FAILED_TERMINAL', 'CANCELLED') THEN
    RAISE EXCEPTION 'campaign transition % -> % is not allowed (% is a terminal state)', OLD.state, NEW.state, OLD.state;
  END IF;

  IF NEW.state IN ('BLOCKED', 'CANCELLED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL') THEN
    RETURN NEW;
  END IF;

  IF OLD.state IN ('BLOCKED', 'FAILED_RETRYABLE') THEN
    IF NEW.state IN ('DRAFT', 'RESEARCHING', 'PLANNED', 'IN_PROGRESS', 'INTERNAL_REVIEW', 'WAITING_APPROVAL') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'campaign transition % -> % is not allowed (recovery from % may only re-enter the pre-approval part of the main sequence)',
      OLD.state, NEW.state, OLD.state;
  END IF;

  IF (OLD.state = 'INTERNAL_REVIEW' AND NEW.state = 'IN_PROGRESS')
     OR (OLD.state = 'WAITING_APPROVAL' AND NEW.state = 'IN_PROGRESS') THEN
    RETURN NEW;
  END IF;

  from_idx := array_position(main_states, OLD.state);
  to_idx := array_position(main_states, NEW.state);
  IF from_idx IS NOT NULL AND to_idx IS NOT NULL AND to_idx = from_idx + 1 THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'campaign transition % -> % is not allowed', OLD.state, NEW.state;
END;
$$ LANGUAGE plpgsql SET search_path = public;
