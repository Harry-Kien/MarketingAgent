-- Fix round 1 on Task 11. Adversarial review reproduced live, twice, against
-- the two functions 0016 introduced for the outbox drain path:
--
-- HIGH: `outbox_mark_published(p_id)` took no proof that the caller ever
-- claimed the row. Any session running as smos_app -- including one scoped
-- to workspace A via withTenant -- could call it directly with workspace
-- B's row id and silently mark B's event published without ever sending
-- it. That is cross-tenant event suppression: a permanent, undetectable
-- loss of another tenant's event, reachable by any ordinary layer-1 bug or
-- injection, exactly the class of failure ADR-007 relies on layer 2 to
-- catch.
--
-- MEDIUM: EXECUTE on `outbox_claim_batch` was granted to smos_app -- the
-- whole application role, not the drain worker specifically. Any request
-- handler, agent tool, or injected query running as smos_app could call it
-- directly and read every tenant's pending payload, regardless of which
-- workspace that session was scoped to. The function was auditable (it is
-- two small statements in one migration file) but not narrow (its callers
-- are every line of application code that will ever run, not just the
-- drain loop).
--
-- Two independent fixes, both forward-only (0016 is not edited):
--
-- 1. A claim token. `outbox_claim_batch` now stamps every row it claims
--    with a single random `claimed_by` value for that call, alongside
--    `claimed_at`. `outbox_mark_published` now takes that token as a
--    second argument and only ever updates a row whose `claimed_by`
--    matches -- and only while it is still unpublished. A caller that
--    never claimed the row, or that supplies the wrong token, updates
--    zero rows. Chosen behavior on mismatch: return `false` (a normal
--    boolean result), not raise. Two reasons: (a) the caller -- drainOutbox
--    -- needs to be able to tell "marked" from "nothing matched" without
--    exception-based control flow for what may be a benign outcome, and
--    (b) a mismatch is not necessarily an attack -- future recovery
--    tooling that re-attempts a mark against a batch that was already
--    claimed by someone else should get a clean "no-op" signal, not a
--    thrown error it has to interpret. drainOutbox itself treats an
--    unexpected `false` (marking a row it just claimed, inside the same
--    still-open transaction, must always succeed) as a hard error, since
--    that can only mean something is badly wrong.
--
-- 2. A separate worker role. `smos_worker` is a new NOLOGIN role that
--    inherits every privilege smos_app has via plain role membership
--    (`GRANT smos_app TO smos_worker`) -- so it automatically tracks
--    whatever smos_app is granted in every past and future migration,
--    with nothing to keep in sync by hand -- plus EXECUTE on exactly these
--    two functions, which smos_app no longer has at all. "No more than
--    smos_app plus these two functions" is therefore structural, not a
--    promise. Like smos_app (0002), it gets LOGIN here but no password:
--    scripts/apply-migrations.mjs sets SMOS_WORKER_PASSWORD afterwards,
--    from an environment variable, never from a migration file.
--
-- Crash recovery for a claimed-but-never-marked batch: claiming and
-- marking happen inside one and the same database transaction throughout
-- drainOutbox (BEGIN ... outbox_claim_batch ... [send, mark]* ... COMMIT).
-- If the process dies before COMMIT, PostgreSQL rolls the whole
-- transaction back on connection loss -- including the UPDATE that
-- stamped claimed_by/claimed_at -- exactly as it does for any other
-- uncommitted work. The row's lock releases at the same moment. Nothing
-- about the crash is written to disk. A later `outbox_claim_batch` call
-- does not exclude previously-claimed rows (it filters only on
-- `published_at IS NULL`) and simply overwrites claimed_by/claimed_at with
-- a fresh token for whichever transaction claims it next. Rows are
-- therefore never permanently stranded and there is no separate release
-- step to remember to run -- ordinary PostgreSQL crash rollback is the
-- entire recovery mechanism. (A crash strictly *after* COMMIT is not a
-- stranding case at all: every row COMMIT covers is either published, by
-- definition, or was never reached by the loop and is simply pending
-- exactly as before that drain ever ran.)

ALTER TABLE outbox ADD COLUMN IF NOT EXISTS claimed_by uuid;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

-- Same signature as 0016 (integer -> SETOF outbox), so CREATE OR REPLACE
-- is a true in-place replacement: owner and prior grants on this exact
-- function object carry over, and are then explicitly re-pointed below.
CREATE OR REPLACE FUNCTION outbox_claim_batch(p_batch_size integer)
RETURNS SETOF outbox
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH token AS (
    SELECT gen_random_uuid() AS claim_token
  ), candidates AS (
    SELECT id FROM outbox
    WHERE published_at IS NULL
    ORDER BY created_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE outbox
  SET claimed_by = token.claim_token, claimed_at = now()
  FROM candidates, token
  WHERE outbox.id = candidates.id
  RETURNING outbox.*;
$$;

-- outbox_mark_published(uuid) from 0016 gains a second parameter here,
-- which PostgreSQL treats as a distinct function object (functions are
-- identified by name *and* parameter types) -- so the old, tokenless
-- 1-argument version is not silently replaced, it still exists and is
-- still exactly as exploitable as the finding above unless dropped
-- outright. Drop it before anything can be granted on the new one.
DROP FUNCTION IF EXISTS outbox_mark_published(uuid);

CREATE FUNCTION outbox_mark_published(p_id uuid, p_claimed_by uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH updated AS (
    UPDATE outbox
    SET published_at = now()
    WHERE id = p_id AND claimed_by = p_claimed_by AND published_at IS NULL
    RETURNING id
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;

ALTER FUNCTION outbox_claim_batch(integer) OWNER TO smos_outbox_drainer;
ALTER FUNCTION outbox_mark_published(uuid, uuid) OWNER TO smos_outbox_drainer;

-- smos_app loses EXECUTE on both functions entirely -- it never had a
-- legitimate reason to call either one itself, only drainOutbox does, and
-- drainOutbox now runs as smos_worker.
REVOKE ALL ON FUNCTION outbox_claim_batch(integer) FROM smos_app;
REVOKE ALL ON FUNCTION outbox_claim_batch(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION outbox_mark_published(uuid, uuid) FROM PUBLIC;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smos_worker') THEN
    CREATE ROLE smos_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
-- Inherits every table/schema grant smos_app has, automatically and
-- forever, via plain PostgreSQL role membership -- not a duplicated grant
-- list that could drift out of sync with future migrations.
GRANT smos_app TO smos_worker;
GRANT EXECUTE ON FUNCTION outbox_claim_batch(integer) TO smos_worker;
GRANT EXECUTE ON FUNCTION outbox_mark_published(uuid, uuid) TO smos_worker;

-- No password is set here for the same reason 0002 sets none for
-- smos_app: npm run lint:secrets forbids a credential in any migration
-- file. scripts/apply-migrations.mjs sets it from SMOS_WORKER_PASSWORD.
ALTER ROLE smos_worker LOGIN NOSUPERUSER NOBYPASSRLS;
