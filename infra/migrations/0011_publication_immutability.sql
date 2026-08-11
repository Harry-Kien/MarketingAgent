-- Fix round 1 on Task 9. Adversarial review reproduced live: a session
-- scoped to smos_app, inside an ordinary tenant-scoped transaction, could
-- UPDATE both publication_content and content_hash together, leaving the
-- row internally self-consistent (a correct sha256 of the new, tampered
-- text). That defeats E3's actual guarantee: a publication is supposed to
-- be a fixed record of specific text that a specific human approved, and
-- Task 9's original migration (0010) never said any of that could not
-- change after insert. A later drift check that merely recomputes
-- content_hash from publication_content and compares them cannot catch
-- this -- both values were changed together, so they still agree; the
-- check only ever proves the row agrees with itself, never that it still
-- matches what approval_decision_id says was approved. A second, smaller
-- hole: content_hash was never validated at INSERT, so a fabricated value
-- (e.g. the literal string 'deadbeef') was accepted outright.
--
-- Two independent fixes, forward-only -- 0010 is applied and is never
-- edited:
--
-- 1. A column-selective BEFORE UPDATE trigger, modelled on
--    approval_decision_is_immutable() in 0007_approval.sql but narrower:
--    approval_decision locks EVERY column via a blanket trigger, because an
--    approval decision is a record of a past act in full. A publication is
--    not -- it also carries its own execution lifecycle (state moving
--    prepared -> executing -> succeeded/failed, plus external_id,
--    permalink and evidence, all written by a later task's connector call),
--    so locking every column would break that. Using PostgreSQL's
--    `BEFORE UPDATE OF <columns>` trigger form, the trigger fires only when
--    an UPDATE's SET clause names one of the five fields that define WHAT
--    is being published and under WHAT approval: publication_content,
--    content_hash, approval_decision_id, content_version_id,
--    idempotency_key. state, external_id, permalink, evidence and
--    updated_at are deliberately absent from that column list and stay
--    freely updatable.
--
-- 2. A CHECK tying content_hash to publication_content via pgcrypto's
--    digest() (the extension is installed by 0000_init_extensions.sql;
--    digest() is IMMUTABLE, confirmed against pg_proc.provolatile, so it is
--    valid inside a CHECK). This closes the INSERT-time hole: a hash that
--    does not match the stored text can no longer be written at all,
--    independent of whether buildPublication computed it correctly.
--    This is defense in depth, not the load-bearing fix -- the trigger
--    above is what actually stops the reviewer's reproduced attack, since
--    an attacker who recomputes a correct hash for their tampered text
--    would otherwise satisfy this CHECK trivially.
CREATE OR REPLACE FUNCTION publication_core_fields_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'publication.% is immutable; a publication is a fixed record of specific text under a specific approval and may never be edited after insert',
    TG_ARGV[0];
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS publication_core_fields_immutable ON publication;
CREATE TRIGGER publication_core_fields_immutable
  BEFORE UPDATE OF publication_content, content_hash, approval_decision_id, content_version_id, idempotency_key
  ON publication
  FOR EACH ROW EXECUTE FUNCTION publication_core_fields_immutable('publication_content/content_hash/approval_decision_id/content_version_id/idempotency_key');

ALTER TABLE publication ADD CONSTRAINT publication_content_hash_check
  CHECK (content_hash = encode(digest(publication_content, 'sha256'), 'hex'));
