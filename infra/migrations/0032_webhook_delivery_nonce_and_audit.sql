-- Late-review CRITICAL 2, database half: a REJECTED or FOREIGN webhook
-- delivery must not be able to consume a genuine delivery id.
--
-- Reproduced live by the reviewer: `deliveryId` is the replay nonce, backed
-- by 0028_integration.sql's UNIQUE (workspace_id, provider, external_id) on
-- webhook_delivery, and smos_app has no DELETE grant on that table -- so the
-- row is permanent by design (that permanence is the whole point: a captured
-- valid request must be non-replayable forever, not merely for a window).
-- Combine that with a signature that did not bind the workspace and the
-- result was a silent, permanent denial-of-service: send `d-burn-1` to
-- workspace B with workspace A's captured signature, and B's own genuine
-- delivery `d-burn-1` afterwards returned 200 with "events before 1, after
-- 1" -- dropped forever, no error, no trace.
--
-- The signature is now workspace-bound (apps/web/src/server/
-- webhook-signature.ts, deriveWorkspaceSecret), which closes the foreign-
-- delivery route at the door. This migration closes the OTHER half at the
-- database, so the nonce cannot be burned by anything that was not itself a
-- verified delivery -- including by the signature_ok = false audit rows the
-- route now writes (0028's own header promised those: "one row per inbound
-- webhook, whether or not its signature verified"; nothing had ever written
-- `false`, so the audit trail it described did not exist).
--
-- The mechanism is a pair of DISJOINT PARTIAL UNIQUE INDEXES, split on
-- signature_ok, replacing the single blanket UNIQUE constraint:
--
--   * verified deliveries keep exactly the uniqueness 0028 gave them -- one
--     row per (workspace, provider, delivery id), which is what makes the
--     replay defense work;
--   * rejected deliveries get their own, separate uniqueness, so recording
--     one can never occupy the key a genuine delivery will later need, and
--     so a forgery replayed a thousand times still collapses to one audit
--     row rather than growing the table without bound.
--
-- Splitting on the boolean rather than, say, adding signature_ok to one
-- composite UNIQUE is deliberate: a single UNIQUE (workspace_id, provider,
-- external_id, signature_ok) would technically also stop the burn, but it
-- silently permits a THIRD state later (a nullable/extra flag value) to open
-- a new key space; two explicit partial indexes whose predicates are exact
-- complements cannot.

ALTER TABLE webhook_delivery
  DROP CONSTRAINT IF EXISTS webhook_delivery_workspace_id_provider_external_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS webhook_delivery_verified_nonce_uidx
  ON webhook_delivery (workspace_id, provider, external_id)
  WHERE signature_ok;

CREATE UNIQUE INDEX IF NOT EXISTS webhook_delivery_rejected_nonce_uidx
  ON webhook_delivery (workspace_id, provider, external_id)
  WHERE NOT signature_ok;

-- webhook_delivery is an audit record of what actually arrived. 0028 granted
-- smos_app UPDATE on it alongside four other tables, but nothing has ever
-- updated a delivery row and nothing legitimately can: flipping signature_ok
-- from false to true after the fact would forge the exact evidence this
-- table exists to hold, and rewriting external_id would move a burned nonce
-- onto a different delivery id -- the same attack this migration closes,
-- through the other door. Two independent mechanisms, per this repository's
-- standing rule: the grant is revoked AND a trigger refuses the UPDATE, so
-- re-granting UPDATE in some future migration is not by itself enough to
-- reopen it.
--
-- UPDATE only, never DELETE: smos_app has no DELETE grant on this table
-- (0028) and never will, which is what makes the nonce permanent for the
-- application; a blanket DELETE trigger would additionally bind the
-- migration role, and 0028's own header names that role as the way
-- integration tests clean up the rows they create. Denying the app while
-- leaving administrative cleanup possible is the same split every other
-- workspace-owned table in this schema already uses.
REVOKE UPDATE ON webhook_delivery FROM smos_app;

CREATE OR REPLACE FUNCTION webhook_delivery_is_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'webhook_delivery is an append-only receipt of what actually arrived; % is not permitted',
    TG_OP;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS webhook_delivery_no_mutation ON webhook_delivery;
CREATE TRIGGER webhook_delivery_no_mutation
  BEFORE UPDATE ON webhook_delivery
  FOR EACH ROW EXECUTE FUNCTION webhook_delivery_is_immutable();
