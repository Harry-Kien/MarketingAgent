-- P4 Task 3: integration connection state, tenant-scoped credential
-- pointers, webhook receipts, lifecycle events and attributed metrics.
--
-- All five tables are workspace-owned per ADR-007: workspace_id NOT NULL,
-- RLS ENABLED and FORCED, and a policy carrying both USING and WITH CHECK
-- so smos_app can neither read nor write across a tenant boundary
-- (0001_core_tenancy.sql's pattern, repeated by every table since).
--
-- Every foreign key below that points from one of these tables at another
-- workspace-owned table (credential_reference -> integration, event ->
-- publication, metric -> campaign) is composite on (id, workspace_id)
-- against a UNIQUE (id, workspace_id) on the parent, exactly like
-- 0008_composite_tenant_fk.sql / 0010_publication.sql / 0024_agent_run.sql:
-- PostgreSQL evaluates a foreign key against its referenced table with RLS
-- bypassed entirely, so a plain single-column `REFERENCES integration(id)`
-- would only prove "some integration row with this id exists anywhere",
-- never that it belongs to the same workspace as the child row -- letting a
-- session scoped to workspace B attach a credential reference to workspace
-- A's integration, or an event/metric to workspace A's publication/campaign.
-- integration and campaign both already carry (or gain here) UNIQUE
-- (id, workspace_id) so the composite FKs below have something to target;
-- workspace_id -> workspace(id) stays a plain FK because workspace is the
-- tenant root and is never itself workspace-owned.
--
-- Text CHECKs use `x ~ '\S'`, never `btrim(...)`
-- (0009_check_whitespace_hardening.sql): PostgreSQL's single-argument
-- btrim() strips only ASCII spaces and lets a value made solely of
-- tabs/newlines through.

CREATE TABLE IF NOT EXISTS integration (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  provider     text NOT NULL CHECK (provider ~ '\S'),
  status       text NOT NULL CHECK (status IN ('not_implemented', 'disconnected', 'connected', 'sandbox')),
  scopes       jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_sync_at timestamptz,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider),
  -- Required so credential_reference's composite FK below can target
  -- (id, workspace_id) -- redundant with the primary key (id alone is
  -- already unique) but PostgreSQL requires the pair itself to be backed by
  -- a UNIQUE or PRIMARY KEY constraint for a composite FK to reference it.
  UNIQUE (id, workspace_id)
);
ALTER TABLE integration ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integration_tenant_isolation ON integration;
CREATE POLICY integration_tenant_isolation ON integration
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- credential_reference is deliberately built so it CANNOT hold a secret
-- (threat T4): the only content-bearing column is `vault_key`, an opaque
-- pointer into an external secret store (e.g. "vault://<workspace>/<slug>")
-- that this database never resolves. There is no `secret`, `token`,
-- `password` or `access_token` column, and none may ever be added here --
-- packages/db/src/credential.test.ts pins the exact column list and
-- lint:secrets scans this file for anything that looks like a real key.
--
-- ON DELETE CASCADE (unlike event/metric below): a credential_reference row
-- carries no audit content of its own, only a live pointer that is
-- meaningless once the integration it names is gone. Deleting the
-- integration (disconnecting the provider) should take its pointer with it
-- rather than leaving an orphaned vault reference for an admin to notice
-- and clean up by hand later.
CREATE TABLE IF NOT EXISTS credential_reference (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspace(id),
  integration_id uuid NOT NULL,
  vault_key      text NOT NULL CHECK (vault_key ~ '\S'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (integration_id, workspace_id) REFERENCES integration (id, workspace_id) ON DELETE CASCADE
);
ALTER TABLE credential_reference ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_reference FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credential_reference_tenant_isolation ON credential_reference;
CREATE POLICY credential_reference_tenant_isolation ON credential_reference
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- webhook_delivery: one row per inbound webhook, whether or not its
-- signature verified (signature_ok records that instead of silently
-- dropping the delivery) -- a rejected signature is exactly the kind of
-- event an audit trail must not omit, same reasoning as tool_call.allowed
-- (0024_agent_run.sql). No FK to anything but workspace: a webhook can
-- arrive for a provider/external_id this workspace has no matching
-- publication or integration row for yet (out-of-order delivery, retries),
-- and recording that fact is the point of this table.
CREATE TABLE IF NOT EXISTS webhook_delivery (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  provider     text NOT NULL CHECK (provider ~ '\S'),
  external_id  text NOT NULL CHECK (external_id ~ '\S'),
  signature_ok boolean NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, external_id)
);
ALTER TABLE webhook_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_delivery FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_delivery_tenant_isolation ON webhook_delivery;
CREATE POLICY webhook_delivery_tenant_isolation ON webhook_delivery
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- publication gets its UNIQUE (id, workspace_id) here, immediately before
-- event's composite FK that depends on it -- 0008/0010's own ordering rule
-- ("each parent's UNIQUE (id, workspace_id) before any child FK that
-- depends on it"). Nothing referenced publication compositely before this
-- migration; 0010_publication.sql never needed one. 0010 is applied and is
-- never edited, so this is added forward-only, here.
ALTER TABLE publication ADD CONSTRAINT publication_id_workspace_id_key UNIQUE (id, workspace_id);

-- event: an append-only record of something that actually happened to a
-- publication (a delivery receipt, an engagement webhook, a status change)
-- -- audit-bearing in the same sense as audit_log, though not literally the
-- same table. publication_id is nullable: an event can legitimately exist
-- before it is matched to a publication (e.g. a webhook that arrives for an
-- external_id this workspace hasn't linked yet), but once set, it must
-- point at a real publication in the SAME workspace -- hence the composite
-- FK rather than a plain one.
--
-- Deletion behaviour, decided deliberately: ON DELETE RESTRICT (spelling
-- out the default NO ACTION for clarity) on publication_id. An event is
-- evidence of what a publication actually did; it must not be allowed to
-- silently disappear -- or be silently orphaned -- because someone later
-- deletes the publication it is about. Blocking that delete, rather than
-- CASCADE-deleting the event or SET NULL-ing the reference, keeps the
-- audit trail intact and forces any future deletion of a publication to be
-- a deliberate, explicit decision about its events too. (Nothing in this
-- schema currently deletes a publication at all -- smos_app has no DELETE
-- grant on it, same as here -- so this is forward-looking, not a guard
-- against anything that happens today.)
CREATE TABLE IF NOT EXISTS event (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspace(id),
  publication_id uuid,
  event_type     text NOT NULL CHECK (event_type ~ '\S'),
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL,
  UNIQUE (id, workspace_id),
  FOREIGN KEY (publication_id, workspace_id) REFERENCES publication (id, workspace_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS event_ws_publication_idx ON event (workspace_id, publication_id);
ALTER TABLE event ENABLE ROW LEVEL SECURITY;
ALTER TABLE event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS event_tenant_isolation ON event;
CREATE POLICY event_tenant_isolation ON event
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- metric: ADR-005 -- a metric that cannot state its freshness and
-- attribution must not exist, so freshness_at, attribution_model,
-- attribution_window and confidence are all NOT NULL, not merely
-- recommended fields a caller might skip. missing_data_note is the
-- explicit, nullable escape hatch for "we know this number is incomplete
-- and here is why", never a silent gap.
--
-- Deletion behaviour: ON DELETE RESTRICT on campaign_id, for the identical
-- reason as event above -- a reported metric is audit-bearing evidence of
-- what was measured and must not vanish because the campaign it measured
-- is later deleted. campaign already carries UNIQUE (id, workspace_id) from
-- 0008_composite_tenant_fk.sql.
CREATE TABLE IF NOT EXISTS metric (
  id                 uuid PRIMARY KEY,
  workspace_id       uuid NOT NULL REFERENCES workspace(id),
  campaign_id        uuid NOT NULL,
  name               text NOT NULL CHECK (name ~ '\S'),
  value              numeric NOT NULL,
  unit               text,
  freshness_at       timestamptz NOT NULL,
  attribution_model  text NOT NULL CHECK (attribution_model ~ '\S'),
  attribution_window text NOT NULL CHECK (attribution_window ~ '\S'),
  confidence         text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  missing_data_note  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (campaign_id, workspace_id) REFERENCES campaign (id, workspace_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS metric_ws_campaign_idx ON metric (workspace_id, campaign_id);
ALTER TABLE metric ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS metric_tenant_isolation ON metric;
CREATE POLICY metric_tenant_isolation ON metric
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- No DELETE grant, matching every other workspace-owned table's runtime
-- grant list (0004_campaign.sql, 0012_agent_registry.sql, 0024_agent_run.sql):
-- smos_app reads, inserts and updates but never deletes. Test cleanup that
-- needs to remove rows created by smos_app-scoped inserts goes through
-- DATABASE_MIGRATION_URL (the smos role), same as every other integration
-- test in packages/db/src.
GRANT SELECT, INSERT, UPDATE ON integration, credential_reference, webhook_delivery, event, metric TO smos_app;
