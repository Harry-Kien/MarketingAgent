-- Task 11: transactional outbox. `enqueueInTransaction` writes an outbox row
-- inside the caller's own `withTenant` transaction, so a domain change and
-- the intent to publish it either both land or neither does (ADR-003).
--
-- Same conventions as every other workspace-owned table since 0008:
--   workspace_id uuid NOT NULL REFERENCES workspace(id), RLS ENABLED and
--   FORCED, policy carrying both USING and WITH CHECK, and a text CHECK
--   using `~ '\S'` rather than btrim() (0009 -- btrim() only strips ASCII
--   spaces, not the full Unicode whitespace class the domain layer rejects).
-- outbox.workspace_id references `workspace`, which is a GLOBAL_TABLES
-- entry (not itself workspace-owned), so a plain single-column FK is
-- correct here -- the composite-FK-against-UNIQUE(id, workspace_id)
-- pattern from 0008 only applies between two workspace-owned tables, and
-- outbox has no FK to any of those.
CREATE TABLE IF NOT EXISTS outbox (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspace(id),
  event_type     text NOT NULL CHECK (event_type ~ '\S'),
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id uuid NOT NULL,
  published_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (created_at) WHERE published_at IS NULL;

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outbox_tenant_isolation ON outbox;
CREATE POLICY outbox_tenant_isolation ON outbox
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- smos_app (the application role, NOBYPASSRLS per ADR-007 -- see
-- rls.test.ts "gives the app role no BYPASSRLS", which this migration must
-- not break) gets SELECT and INSERT only. It never gets UPDATE: nothing in
-- the application ever marks an outbox row published directly, only the
-- drain path below does, and only through a narrow, audited function --
-- never by widening the app role's own privileges.
GRANT SELECT, INSERT ON outbox TO smos_app;

-- --------------------------------------------------------------------------
-- drainOutbox crosses workspaces by design: one worker drains every
-- tenant's pending events in a single pass. That is fundamentally at odds
-- with RLS's per-workspace USING clause, which only ever exposes the one
-- workspace named by app.workspace_id -- with no session variable set,
-- current_setting(..., true) reads NULL, `workspace_id = NULL` is never
-- true, and smos_app would see zero rows for every tenant, silently.
--
-- The fix is NOT to grant smos_app BYPASSRLS. That would satisfy the drain
-- path but also hand every other application code path -- every future
-- endpoint, every bug -- the ability to bypass RLS on every table, which is
-- exactly the class of incident ADR-007's layer 2 exists to make
-- impossible regardless of an application bug. rls.test.ts already pins
-- smos_app.rolbypassrls = false; that invariant must hold after this
-- migration too.
--
-- Instead: a second role, smos_outbox_drainer, NOLOGIN (nothing ever
-- connects AS it directly) and BYPASSRLS, owns exactly two SQL functions
-- that do exactly what draining needs and nothing else. smos_app is only
-- ever granted EXECUTE on those two functions -- never SELECT/UPDATE on
-- outbox across workspaces, never BYPASSRLS itself. This is a deliberate,
-- narrow, auditable privilege escalation scoped to two single-statement
-- functions, not an incidental widening of the connecting role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smos_outbox_drainer') THEN
    CREATE ROLE smos_outbox_drainer NOLOGIN NOSUPERUSER BYPASSRLS;
  END IF;
END $$;
GRANT SELECT, UPDATE ON outbox TO smos_outbox_drainer;

-- Claims up to p_batch_size pending rows for the caller's own transaction:
-- FOR UPDATE SKIP LOCKED is what lets two concurrent drains split a batch
-- without either one blocking on, or double-publishing, the other's rows.
-- The lock is held by whatever transaction calls this function (locking
-- behaves normally inside a SQL-language function; SECURITY DEFINER only
-- changes which role's privileges/RLS-bypass apply while it runs) until
-- that transaction commits or rolls back.
CREATE OR REPLACE FUNCTION outbox_claim_batch(p_batch_size integer)
RETURNS SETOF outbox
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM outbox
  WHERE published_at IS NULL
  ORDER BY created_at ASC
  LIMIT p_batch_size
  FOR UPDATE SKIP LOCKED;
$$;
ALTER FUNCTION outbox_claim_batch(integer) OWNER TO smos_outbox_drainer;
REVOKE ALL ON FUNCTION outbox_claim_batch(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_claim_batch(integer) TO smos_app;

-- Marks a single previously-claimed row published. Called once per row,
-- immediately after that row's event is actually handed to the queue --
-- never before -- so a row can only ever read as published if it was truly
-- sent.
CREATE OR REPLACE FUNCTION outbox_mark_published(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE outbox SET published_at = now() WHERE id = p_id;
$$;
ALTER FUNCTION outbox_mark_published(uuid) OWNER TO smos_outbox_drainer;
REVOKE ALL ON FUNCTION outbox_mark_published(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_mark_published(uuid) TO smos_app;
