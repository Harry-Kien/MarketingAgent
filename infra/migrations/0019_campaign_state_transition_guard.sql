-- Final whole-branch review, FINDING 6 (LOW, but load-bearing). Reproduced
-- live: `UPDATE campaign SET state = 'APPROVED'` succeeds directly from
-- DRAFT as smos_app. 0005_campaign_state_check.sql constrains campaign.state
-- to the 15 real lifecycle states but never constrains which transitions
-- between those states are legal -- even though that same file's header
-- claims state is "never reachable via a general-purpose UPDATE that isn't
-- validated" (Invariant D). The domain layer (packages/domain/src/
-- lifecycle.ts, canTransition/applyTransition) already enforces which
-- transitions are legal, but nothing in the database backed that claim up,
-- unlike every other invariant this milestone protects (campaign state's
-- own value set has 0005, approval actor has 0007, publication content has
-- 0011, agent activation has 0013/0018).
--
-- This migration adds a BEFORE UPDATE OF state trigger on campaign that
-- mirrors canTransition exactly:
--   - from === to is never allowed (0005's CHECK already guarantees `to` is
--     one of the 15 real states; this rejects a no-op "transition" the same
--     way canTransition does).
--   - once in a terminal state (COMPLETED, FAILED_TERMINAL, CANCELLED), no
--     further transition is ever allowed.
--   - BLOCKED, CANCELLED, FAILED_RETRYABLE, FAILED_TERMINAL are reachable
--     from any other non-terminal state (canTransition's blanket "off-ramp"
--     rule) -- checked before anything else below, mirroring canTransition's
--     own ordering.
--   - recovering from BLOCKED or FAILED_RETRYABLE may only re-enter the
--     pre-approval part of the main sequence (DRAFT..WAITING_APPROVAL) --
--     going through a side state must never be a shortcut around approval
--     (blueprint invariant 2; also the exact case a reviewer would try
--     first, so it is proven directly below rather than only exercised by
--     the exhaustive cross-check test).
--   - the two rework edges (INTERNAL_REVIEW -> IN_PROGRESS,
--     WAITING_APPROVAL -> IN_PROGRESS) are legal.
--   - otherwise a transition is legal only if it is one step forward along
--     MAIN_STATES (DRAFT, RESEARCHING, PLANNED, IN_PROGRESS,
--     INTERNAL_REVIEW, WAITING_APPROVAL, APPROVED, SCHEDULED, EXECUTING,
--     MEASURING, COMPLETED -- same list and order as 0005's CHECK and
--     packages/domain/src/lifecycle.ts's MAIN_STATES, changed only
--     together).
--
-- Deliberately NOT mirrored here: applyTransition's two extra rules that a
-- transition INTO APPROVED requires a recorded ApprovalDecision and a user
-- actor. Those depend on data outside a single campaign row (an
-- approval_decision row, and who is calling) that a BEFORE ROW trigger on
-- campaign has no principled way to see -- approval_decision's own actor
-- CHECK plus FK (0007_approval.sql) is what backs that half of the
-- invariant at the database, and this migration only closes the part 0005's
-- header actually claimed and the reviewer actually reproduced: that a
-- general UPDATE cannot move state at all outside the legal transition
-- graph.
--
-- INSERT is untouched on purpose (BEFORE UPDATE OF state, not BEFORE
-- INSERT): campaign-state-check.test.ts's existing "accepts all fifteen
-- valid lifecycle states" test inserts a campaign directly at each of the
-- 15 states, which is how every fixture in this codebase seeds a campaign
-- at a state other than DRAFT for isolated testing, and createCampaign
-- (packages/domain/src/campaign.ts) itself always creates at DRAFT.
--
-- SET search_path = public per the FINDING 1 audit (0018_function_search_
-- path_hardening.sql) -- every function this branch creates from now on is
-- pinned from the start rather than needing a follow-up migration.
--
-- Idempotent: CREATE OR REPLACE and DROP TRIGGER IF EXISTS/CREATE TRIGGER
-- make re-running this file safe.
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

  IF NEW.state = OLD.state THEN
    RAISE EXCEPTION 'campaign transition % -> % is not allowed (from and to must differ)', OLD.state, NEW.state;
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

-- No WHEN clause: unlike the immutability triggers elsewhere in this schema
-- (which only need to fire when a value actually changes), canTransition
-- itself treats from === to as an illegal transition (from-and-to-must-
-- differ is checked before anything else in lifecycle.ts), so a same-value
-- `UPDATE campaign SET state = 'PLANNED'` while already PLANNED must be
-- refused too, not silently treated as a no-op. The trigger must fire on
-- every UPDATE that names the state column, whether or not the value
-- actually differs, so that decision is made in one place (the function
-- body) rather than being pre-filtered out here.
DROP TRIGGER IF EXISTS campaign_validate_state_transition ON campaign;
CREATE TRIGGER campaign_validate_state_transition
  BEFORE UPDATE OF state ON campaign
  FOR EACH ROW
  EXECUTE FUNCTION campaign_validate_state_transition();
