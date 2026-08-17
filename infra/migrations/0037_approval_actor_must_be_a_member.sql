-- Final whole-branch review, CRITICAL 2: "nothing binds the approver to the
-- workspace, and the kill chain holds."
--
-- approval_decision.actor_user_id's foreign key referenced user_account(id)
-- and NOTHING ELSE. It proves the recorded approver is a real human
-- SOMEWHERE in the system; it says nothing at all about that human having
-- any authority in the workspace being approved for. handlePublish
-- (apps/worker/src/handlers/publish.ts) then checks the actor's SHAPE --
-- isId(actorUserId), decision === 'approve', workspace match, content-version
-- match, channel match, content-hash match -- and never their AUTHORITY.
--
-- Reproduced live by the reviewer, end to end, from ONE smos_app SQL
-- connection: choose any app.workspace_id, insert an approval_request, insert
-- an approval_decision with actor_kind='user' and actor_user_id set to any
-- row in user_account -- including a user who is not a member of that
-- workspace at all -- then insert a publication. handlePublish passed every
-- gate and published "AGENT-GENERATED TEXT NO HUMAN EVER SAW".
--
-- This is the fifth time on this branch that an invariant living only in
-- TypeScript was defeated by direct SQL as smos_app, so the binding goes at
-- the database. Two independent mechanisms, per this repository's standing
-- rule that removing one must not be enough (0001's audit_log, 0007's
-- approval_decision, 0031's two locks):
--
-- LOCK 1 -- a COMPOSITE FOREIGN KEY from the decision to the membership.
--   (workspace_id, actor_user_id) -> workspace_member (workspace_id,
--   user_id), the same tool 0008_composite_tenant_fk.sql uses for every
--   tenant-to-tenant edge and 0031 reused for the decision/request snapshot.
--   It fits exactly: workspace_member already carries UNIQUE (workspace_id,
--   user_id) from 0029, which is the referenced key a composite FK needs,
--   and the pair being constrained is precisely the claim being made --
--   "this person had standing IN THIS WORKSPACE when they decided". Both
--   halves matter: a single-column FK to workspace_member.user_id would
--   accept a member of some OTHER workspace, which is the sharper half of
--   the same attack and is covered by its own test.
--
--   Because a foreign key constrains the referenced side too, the membership
--   row that a recorded decision points at can no longer be deleted while
--   that decision exists -- the evidence of authority outlives the moment,
--   the same way 0031's FK makes an approval_request unable to move out from
--   under a decision that answers it.
--
-- LOCK 2 -- smos_app may no longer WRITE workspace_member at all.
--   Lock 1 alone would have been theatre: 0029 granted smos_app INSERT and
--   UPDATE on workspace_member, so a compromised agent -- which runs as
--   exactly this role -- could insert (its own current workspace, any
--   existing user_account row) inside its own RLS scope and then approve as
--   that person. The identical kill chain, one statement longer. Enrolling a
--   human in a workspace is an administrative act for the same reason
--   provisioning the human is (0030_user_account_no_app_write.sql): it is
--   the act that CREATES authority, and the role every agent rides on must
--   never be able to perform it. Every existing writer of this table already
--   goes through the migration role -- packages/testing/src/tenant-fixtures.ts,
--   apps/web/e2e/fixtures/auth-seed.ts, packages/db/src/auth-schema.test.ts --
--   so nothing legitimate loses a capability here. SELECT stays: reading who
--   is in your own workspace is normal application work, still RLS-scoped by
--   0029's policy.
--
-- WHY NOT A TRIGGER instead of the FK: a trigger would have to be SECURITY
-- DEFINER to see workspace_member past its own RLS, which is precisely the
-- shape IMPORTANT 6 below is about. A foreign key is checked by the system
-- with referential-integrity privileges, needs no elevated function of ours,
-- constrains the referenced side as well as the referencing one, and cannot
-- be bypassed by a trigger being disabled.
--
-- BACKFILL. 296 of the 556 approval_decision rows already in this database
-- name an actor with no membership in the workspace they decided for -- all
-- of them created by test runs against the shared development database over
-- the life of this branch, before any such rule existed. They cannot be
-- deleted (approval_decision is append-only for every role, 0007) and the
-- constraint cannot be added while they violate it. Each such pair is
-- therefore recorded as the membership it was always implicitly asserting:
-- a decision IS the claim "this user acted in this workspace", so writing
-- that claim down changes no meaning, it only puts it where the database can
-- check it from now on.
--
--   created_at is NOT backdated to the decision. resolve_user_workspace
--   (0029) resolves a user to their FIRST membership by created_at, so a
--   backfilled row dated to an old decision could quietly become the
--   workspace a real user resolves to at sign-in. now() keeps every genuine,
--   already-existing membership older, and therefore still winning.
--
-- Text CHECKs, function hardening and schema qualification conventions:
-- 0009/0018/0022, unchanged.

INSERT INTO workspace_member (id, workspace_id, user_id, role, created_at)
SELECT gen_random_uuid(), d.workspace_id, d.actor_user_id, 'owner', now()
  FROM (SELECT DISTINCT workspace_id, actor_user_id FROM approval_decision) d
 WHERE NOT EXISTS (
   SELECT 1 FROM workspace_member m
    WHERE m.workspace_id = d.workspace_id AND m.user_id = d.actor_user_id
 );

ALTER TABLE approval_decision
  ADD CONSTRAINT approval_decision_actor_is_workspace_member_fkey
  FOREIGN KEY (workspace_id, actor_user_id)
  REFERENCES workspace_member (workspace_id, user_id);

REVOKE INSERT, UPDATE ON workspace_member FROM smos_app;

-- Final whole-branch review, IMPORTANT 6: "one FK away from a hole."
--
-- approval_decision_snapshot_request (0031) is SECURITY DEFINER, owned by the
-- migration role (a superuser, so RLS does not apply to it), and it read
--
--     FROM public.approval_request r WHERE r.id = NEW.approval_request_id
--
-- with NO workspace filter whatsoever, then copied what it found into the
-- decision's own NOT NULL content_version_id / target_channel columns. It is
-- safe today only because a DIFFERENT statement in a DIFFERENT migration --
-- 0031's own approval_decision_matches_request_fkey, plus 0008's
-- (approval_request_id, workspace_id) composite -- rejects the result
-- afterwards. Proven by dropping exactly those two constraints and running
-- the insert: a decision in workspace A took workspace B's content version
-- and target channel, written with superuser privileges
-- (packages/db/src/approval-request-frozen.test.ts's IMPORTANT 6 block, which
-- restores both constraints in a finally and cleans up the row it may have
-- created so a failing run cannot leave this schema short of two foreign
-- keys).
--
-- A trigger's safety must not live in another migration. The filter is added
-- here, and the "no matching request in this workspace" case now RAISES by
-- name instead of falling through to a bare NOT NULL violation, so the
-- refusal says what actually went wrong. 0031's foreign keys stay exactly
-- where they are -- this is the second independent mechanism, not a
-- replacement for the first.
CREATE OR REPLACE FUNCTION approval_decision_snapshot_request() RETURNS trigger AS $$
BEGIN
  IF NEW.content_version_id IS NULL OR NEW.target_channel IS NULL THEN
    SELECT COALESCE(NEW.content_version_id, r.content_version_id),
           COALESCE(NEW.target_channel, r.target_channel)
      INTO NEW.content_version_id, NEW.target_channel
      FROM public.approval_request r
     WHERE r.id = NEW.approval_request_id
       AND r.workspace_id = NEW.workspace_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'approval_decision % names approval_request %, which does not exist in workspace % -- a decision may only snapshot a request from its own workspace',
        NEW.id, NEW.approval_request_id, NEW.workspace_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
