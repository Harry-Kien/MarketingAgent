-- Fix round 1 on Task 6: campaign.state was `text NOT NULL` with no
-- constraint on its actual values, so an arbitrary string (a backfill, a raw
-- SQL fix during an incident, a future ORM path that bypasses
-- transitionCampaign) could silently corrupt it. Invariant D requires state
-- to never be reachable via a general-purpose UPDATE that isn't validated;
-- the domain layer (packages/domain/src/lifecycle.ts, canTransition /
-- applyTransition) already enforces which transitions are legal, but nothing
-- in the database enforced that the column could only ever hold one of the
-- 15 real lifecycle states in the first place.
--
-- This list MUST mirror MAIN_STATES + SIDE_STATES in
-- packages/domain/src/lifecycle.ts exactly -- the two are changed together,
-- never independently. As of this migration:
--   MAIN_STATES: DRAFT, RESEARCHING, PLANNED, IN_PROGRESS, INTERNAL_REVIEW,
--                WAITING_APPROVAL, APPROVED, SCHEDULED, EXECUTING, MEASURING,
--                COMPLETED
--   SIDE_STATES: BLOCKED, FAILED_RETRYABLE, FAILED_TERMINAL, CANCELLED
--
-- Named constraint (not an anonymous CHECK) so a violation's error message is
-- readable rather than a generic constraint-name hash. Idempotent: DROP
-- CONSTRAINT IF EXISTS before ADD CONSTRAINT makes re-running this file safe.
ALTER TABLE campaign DROP CONSTRAINT IF EXISTS campaign_state_valid;
ALTER TABLE campaign ADD CONSTRAINT campaign_state_valid CHECK (
  state IN (
    'DRAFT', 'RESEARCHING', 'PLANNED', 'IN_PROGRESS', 'INTERNAL_REVIEW',
    'WAITING_APPROVAL', 'APPROVED', 'SCHEDULED', 'EXECUTING', 'MEASURING',
    'COMPLETED',
    'BLOCKED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'CANCELLED'
  )
);
