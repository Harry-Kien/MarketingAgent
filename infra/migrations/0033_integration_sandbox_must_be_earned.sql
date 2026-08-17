-- Late-review IMPORTANT 3: `integration.status = 'sandbox'` was a bare
-- assertion.
--
-- Reproduced by the reviewer: inserting (or updating to) that value directly
-- was accepted outright, and the Integrations page then rendered the badge
-- "Sandbox (đã xác minh)" -- literally "verified" -- while
-- `isChannelConnected` (apps/web/src/server/channel-status.ts) flipped to
-- true, opening the channel gate on the approval path. There was no
-- verification-then-write to defeat, because NO production code path has
-- ever written integration.status at all: the strongest evidentiary claim
-- this milestone can make was simply available for the asking.
--
-- 0028_integration.sql's own header says what 'sandbox' is supposed to mean:
-- "the adapter has actually been exercised successfully against the Meta
-- sandbox". That is a checkable fact about rows this database already holds,
-- so it is checked here rather than merely described in a comment.
--
-- The evidence: a `publication` in the SAME workspace that actually reached
-- state 'succeeded' with an `external_id` the provider assigned. That is not
-- a weak proxy -- a publication row cannot exist without a NOT NULL
-- `approval_decision_id`, and an approval_decision cannot exist without a
-- real `user_account` actor (0007_approval.sql's foreign key plus its
-- actor_kind CHECK), so "this integration is verified" now chains all the
-- way back to a specific human approval and a specific successful adapter
-- call. Fabricating it requires fabricating that entire chain.
--
-- Four mechanisms, deliberately overlapping so that removing any one still
-- leaves the claim unearnable:
--
--  1. A new column `verified_publication_id`, plus a CHECK that ties it to
--     the status: status = 'sandbox' REQUIRES it, and every other status
--     REQUIRES it to be absent (so a row cannot carry stale evidence for a
--     claim it is no longer making).
--  2. A COMPOSITE foreign key on (verified_publication_id, workspace_id) ->
--     publication (id, workspace_id), 0008_composite_tenant_fk.sql's
--     pattern: a single-column REFERENCES would only prove "some publication
--     with this id exists somewhere", letting workspace B cite workspace A's
--     success as its own. Cross-tenant citation is exactly the shape of hole
--     this repository has already closed three times.
--  3. A trigger checking the facts a foreign key cannot express: the cited
--     publication must be state = 'succeeded' AND carry a non-null
--     external_id (a publication that failed, or that never got an id back
--     from the provider, is not evidence the adapter works), and its
--     target_channel must belong to THIS provider -- otherwise a successful
--     Meta post would verify a TikTok integration.
--     ON INSERT OR UPDATE, because promoting an existing row is the same
--     claim through the other door and 0026's `BEFORE UPDATE OF state` gap
--     is the standing lesson about under-scoping a trigger's firing
--     condition.
--  4. The provider mapping mirrors channel-status.ts's providerForChannel
--     ("meta_page" -> "meta"): the part before the first underscore. Kept
--     deliberately identical so the database and the application cannot
--     disagree about which channel belongs to which provider.
--
-- Deliberately NOT done here: constraining 'connected' to require a
-- credential_reference row. credential_reference's own FK points AT
-- integration, so requiring the reverse at insert time is circular -- the
-- integration row must exist before its credential can. That claim needs a
-- deferred constraint or a status-transition trigger, and 'connected' is
-- already the weaker, honestly-labelled claim ("configured", per
-- apps/web/src/app/(app)/integrations/status.ts); 'sandbox' is the one that
-- says "verified", so it is the one closed here.

ALTER TABLE integration ADD COLUMN IF NOT EXISTS verified_publication_id uuid;

-- Every 'sandbox' row that exists today was written before any of this
-- existed, i.e. it is exactly the unearned claim this migration outlaws, and
-- there is no evidence anywhere to backfill it from. Revoking the claim is
-- the only honest option: they become 'disconnected' -- "an adapter exists,
-- nothing is configured yet" -- which is a statement this database can
-- actually stand behind. Under-claiming is recoverable (re-verify and the
-- status is re-earned); leaving an unverifiable "đã xác minh" badge on
-- screen is not.
UPDATE integration SET status = 'disconnected'
 WHERE status = 'sandbox' AND verified_publication_id IS NULL;

ALTER TABLE integration ADD CONSTRAINT integration_sandbox_needs_evidence_check
  CHECK (
    (status = 'sandbox' AND verified_publication_id IS NOT NULL)
    OR (status <> 'sandbox' AND verified_publication_id IS NULL)
  );

ALTER TABLE integration
  ADD CONSTRAINT integration_verified_publication_fkey
  FOREIGN KEY (verified_publication_id, workspace_id)
  REFERENCES publication (id, workspace_id);

CREATE OR REPLACE FUNCTION integration_sandbox_evidence_is_real() RETURNS trigger AS $$
DECLARE
  pub_state       text;
  pub_external_id text;
  pub_channel     text;
BEGIN
  IF NEW.verified_publication_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.state, p.external_id, p.target_channel
    INTO pub_state, pub_external_id, pub_channel
    FROM public.publication p
   WHERE p.id = NEW.verified_publication_id
     AND p.workspace_id = NEW.workspace_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'integration.verified_publication_id % names no publication in workspace %',
      NEW.verified_publication_id, NEW.workspace_id;
  END IF;

  IF pub_state <> 'succeeded' OR pub_external_id IS NULL THEN
    RAISE EXCEPTION
      'integration cannot claim status "sandbox": publication % is state "%" with external_id %, which is not evidence the adapter ever succeeded',
      NEW.verified_publication_id, pub_state, coalesce(pub_external_id, 'NULL');
  END IF;

  IF split_part(pub_channel, '_', 1) IS DISTINCT FROM NEW.provider THEN
    RAISE EXCEPTION
      'integration for provider "%" cannot be verified by a publication sent to channel "%": a success on one provider is not evidence about another',
      NEW.provider, pub_channel;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS integration_sandbox_evidence_is_real ON integration;
CREATE TRIGGER integration_sandbox_evidence_is_real
  BEFORE INSERT OR UPDATE ON integration
  FOR EACH ROW EXECUTE FUNCTION integration_sandbox_evidence_is_real();
