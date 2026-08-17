-- Late-review CRITICAL 1: an approval could be RETARGETED after the decision,
-- so unapproved content published under a genuine human approval.
--
-- Reproduced live as smos_app against this database (not a mock), exactly as
-- the reviewer ran it:
--
--   -- founder approves content_version v1 for target_channel 'meta_page'
--   insert into approval_decision (...) values (..., 'approve', 'ok');
--   -- a later, never-reviewed revision v2 is created
--   update approval_request
--      set content_version_id = <v2>, target_channel = 'tiktok_account'
--    where id = <arId>;                       -- ACCEPTED, rowCount = 1
--
-- ...and the publish then reported `state: succeeded, posts: 1`.
-- 0007_approval.sql grants smos_app UPDATE on approval_request (line 66) and
-- nothing ever froze the row, so this is the project's governing failure mode
-- for the fourth time: an invariant that lived only in TypeScript, defeated
-- by direct SQL as smos_app.
--
-- Why handlePublish's existing guard did not catch it: it compares
-- `decision.contentVersionId !== pub.contentVersionId`, but `decision`'s
-- contentVersionId is not a column on approval_decision at all -- the loader
-- joins it out of approval_request.content_version_id, i.e. out of the very
-- column the attacker just rewrote. It compared v2 to v2 and passed. The
-- approval_decision row -- the actual, immutable record of the human act --
-- never recorded WHAT was approved, only THAT something was.
--
-- Two independent database mechanisms, per this repository's standing rule
-- that revoking or dropping one must not be enough (0001_core_tenancy.sql's
-- audit_log, 0007_approval.sql's approval_decision):
--
-- LOCK 1 -- approval_request is frozen once a decision exists.
--   Whole-row, via to_jsonb(OLD) vs to_jsonb(NEW), following
--   0027_agent_run_immutable_when_terminal.sql rather than 0011's
--   hand-enumerated column list: 0027's own header records that enumerating
--   is "exactly the shape of gap this finding proves easy to under-scope",
--   and that is precisely what happened here -- the reviewer named
--   content_version_id and target_channel, but campaign_id (which campaign
--   the post is attributed to), policy_flags (the risk warnings the founder
--   was shown before deciding), estimated_impact (the impact estimate they
--   weighed), created_at (when the request they answered was raised), id and
--   workspace_id are every bit as much part of "what was approved". Column by
--   column, the answer to "may this still change after a decision?" is no for
--   all eight: approval_request has no post-decision lifecycle of its own --
--   unlike publication (0011, which keeps executing/succeeded plus
--   external_id/permalink/evidence moving) and unlike agent_run (0027, which
--   keeps updated_at moving), it carries no state, no updated_at and no
--   result columns. There is therefore no exempt column here at all, not even
--   updated_at, because the table does not have one.
--
--   A row-identical UPDATE is still permitted (the to_jsonb comparison is
--   IS DISTINCT FROM, not "an UPDATE happened"), so an idempotent re-write of
--   the same values does not fail -- 0023_campaign_state_noop_update.sql's
--   precedent, reused by 0026 and 0027.
--
--   An UNDECIDED request stays freely editable: a pending request that no
--   human has answered yet is a draft, and editing it changes nothing about
--   any recorded decision, because there is none. The GRANT UPDATE from
--   0007 is therefore deliberately KEPT rather than revoked -- revoking it
--   outright would forbid that legitimate case while adding nothing against
--   this attack, which is entirely about the post-decision window.
--
--   SECURITY DEFINER (owner: the migration role, which bypasses RLS) so the
--   EXISTS probe cannot be defeated by an approval_decision row being
--   invisible under the caller's RLS scope. The body contains no dynamic SQL,
--   schema-qualifies its one table reference, and pins search_path per
--   0018_function_search_path_hardening.sql / 0022, so the elevated context
--   has no reachable surface beyond that single existence check.
--
-- LOCK 2 -- approval_decision records WHAT was approved, itself.
--   content_version_id and target_channel become real columns on
--   approval_decision, which is already whole-row immutable (0007's
--   approval_decision_no_mutation trigger, plus REVOKE UPDATE, DELETE). They
--   are tied to the request by a COMPOSITE FOREIGN KEY on
--   (approval_request_id, workspace_id, content_version_id, target_channel),
--   the same tool 0008_composite_tenant_fk.sql uses for tenancy: it is
--   impossible to record a decision whose snapshot disagrees with the request
--   it answers, AND -- because a foreign key constrains the referenced side
--   too -- it is independently impossible to move approval_request's
--   content_version_id or target_channel out from under a decision that
--   already points at them, even with LOCK 1's trigger dropped.
--
--   handlePublish now compares publication.content_version_id and
--   publication.target_channel against THESE columns (defence in depth), so
--   the gate reads the immutable decision rather than the mutable request.
--
-- Backfill: every existing approval_decision takes its snapshot from the
-- approval_request it already points at (approval_decision.approval_request_id
-- is NOT NULL and foreign-keyed, so there are no orphans), then both columns
-- become NOT NULL. Nothing is lost and no historical row changes meaning --
-- until this migration, the request WAS the only record of those values.

ALTER TABLE approval_decision ADD COLUMN IF NOT EXISTS content_version_id uuid;
ALTER TABLE approval_decision ADD COLUMN IF NOT EXISTS target_channel text;

-- 0007's approval_decision_no_mutation trigger refuses every UPDATE on this
-- table unconditionally, including this one -- correctly, since it does not
-- (and must not) carry a "unless you are a migration" exemption. It is
-- disabled for the duration of the backfill and re-enabled immediately, both
-- inside the single transaction scripts/apply-migrations.mjs wraps every
-- migration file in; ALTER TABLE takes ACCESS EXCLUSIVE, so no other session
-- can observe or exploit the window. The backfill writes each decision the
-- values its own approval_request already holds -- it changes no meaning,
-- only where the value is recorded.
ALTER TABLE approval_decision DISABLE TRIGGER approval_decision_no_mutation;

UPDATE approval_decision d
   SET content_version_id = r.content_version_id,
       target_channel     = r.target_channel
  FROM approval_request r
 WHERE r.id = d.approval_request_id
   AND (d.content_version_id IS NULL OR d.target_channel IS NULL);

ALTER TABLE approval_decision ENABLE TRIGGER approval_decision_no_mutation;

ALTER TABLE approval_decision ALTER COLUMN content_version_id SET NOT NULL;
ALTER TABLE approval_decision ALTER COLUMN target_channel SET NOT NULL;
ALTER TABLE approval_decision ADD CONSTRAINT approval_decision_target_channel_check
  CHECK (target_channel ~ '\S');

-- The composite FK below needs this exact column set backed by a UNIQUE
-- constraint. Redundant with the primary key (id alone is already unique),
-- required by PostgreSQL's grammar all the same -- 0028_integration.sql's
-- UNIQUE (id, workspace_id) exists for the identical reason.
ALTER TABLE approval_request
  ADD CONSTRAINT approval_request_id_ws_version_channel_key
  UNIQUE (id, workspace_id, content_version_id, target_channel);

ALTER TABLE approval_decision
  ADD CONSTRAINT approval_decision_matches_request_fkey
  FOREIGN KEY (approval_request_id, workspace_id, content_version_id, target_channel)
  REFERENCES approval_request (id, workspace_id, content_version_id, target_channel);

-- The snapshot is DERIVED by the database from the request being answered
-- whenever the caller does not supply it, rather than being an extra pair of
-- values every INSERT site has to remember to pass correctly. A caller that
-- DOES supply them (submit-approval.ts and the domain's decideApproval both
-- do, so the values travel with the decision object) is still checked against
-- the request by the composite foreign key above -- deriving is a default,
-- never an override, so a wrong snapshot is refused rather than silently
-- corrected.
--
-- SECURITY DEFINER for the same reason as the freeze trigger below: the
-- lookup must not depend on the request being visible under the caller's RLS
-- scope. It is not a tenancy hole -- a decision whose workspace_id differs
-- from the request's still fails the composite FK, which is exactly what
-- packages/db/src/cross-workspace-fk.test.ts already proves.
CREATE OR REPLACE FUNCTION approval_decision_snapshot_request() RETURNS trigger AS $$
BEGIN
  IF NEW.content_version_id IS NULL OR NEW.target_channel IS NULL THEN
    SELECT COALESCE(NEW.content_version_id, r.content_version_id),
           COALESCE(NEW.target_channel, r.target_channel)
      INTO NEW.content_version_id, NEW.target_channel
      FROM public.approval_request r
     WHERE r.id = NEW.approval_request_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS approval_decision_snapshot_request ON approval_decision;
CREATE TRIGGER approval_decision_snapshot_request
  BEFORE INSERT ON approval_decision
  FOR EACH ROW EXECUTE FUNCTION approval_decision_snapshot_request();

CREATE OR REPLACE FUNCTION approval_request_frozen_after_decision() RETURNS trigger AS $$
BEGIN
  IF to_jsonb(OLD) IS NOT DISTINCT FROM to_jsonb(NEW) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.approval_decision d WHERE d.approval_request_id = OLD.id
  ) THEN
    RAISE EXCEPTION
      'approval_request % has already been decided; it is the immutable record of what a human was shown when they decided and may not be modified afterwards',
      OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS approval_request_frozen_after_decision ON approval_request;
CREATE TRIGGER approval_request_frozen_after_decision
  BEFORE UPDATE ON approval_request
  FOR EACH ROW EXECUTE FUNCTION approval_request_frozen_after_decision();

-- A decided request must not be deletable either -- deleting and re-inserting
-- the id would be the same attack by another route. smos_app has no DELETE
-- grant on approval_request today (0007 grants SELECT, INSERT, UPDATE only),
-- so this is the second, independent statement of that rule rather than the
-- only one; the composite FK above already refuses the delete as well.
REVOKE DELETE ON approval_request FROM smos_app;
