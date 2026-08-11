-- ADR-007 requires the application to connect with a DB role that has no
-- BYPASSRLS, and migrations to run under a separate role. Neither was true:
-- smos_app (created NOLOGIN in 0001) could never actually be connected to,
-- so the application connected as `smos` instead -- a PostgreSQL superuser
-- for which FORCE ROW LEVEL SECURITY does not apply at all. `withTenant`'s
-- `SET LOCAL ROLE smos_app` only ever narrowed that superuser connection;
-- callback code issuing `RESET ROLE` / `SET ROLE smos` undid the narrowing
-- and regained full superuser access (task-5-report.md). This migration
-- closes that by letting smos_app log in directly, while keeping it
-- NOSUPERUSER and NOBYPASSRLS exactly as 0001 declared it.
--
-- No password is set here -- npm run lint:secrets forbids a credential
-- appearing in any migration file. scripts/apply-migrations.mjs sets it
-- afterwards from the SMOS_APP_PASSWORD environment variable.
--
-- Idempotent: ALTER ROLE unconditionally (re)applies the same attributes on
-- every run; every GRANT/CREATE below is IF-NOT-EXISTS or GRANT (itself
-- idempotent), so re-running this file has no additional effect.
ALTER ROLE smos_app LOGIN NOSUPERUSER NOBYPASSRLS;

-- smos_app is now the role that connects directly -- including the seed
-- step tests use to create their fixture workspace rows -- not just a role
-- a superuser session narrows into. It needs to be able to create a
-- workspace, not merely read one. `workspace` carries no RLS policy (it is
-- an allowlisted global table per ADR-007 / GLOBAL_TABLES), so this is a
-- plain permission grant, nothing tenant-scoped.
GRANT INSERT ON workspace TO smos_app;

-- pg-boss (packages/queue) shares this database (ADR-003) and, like the
-- rest of the application, now connects as smos_app instead of the
-- superuser. Its `pgboss` schema is infrastructure for the job queue, not
-- tenant data, so it sits outside ADR-007's RLS scope entirely -- this is
-- just making smos_app able to do the job pg-boss needs, the same way the
-- grants above do for the domain tables.
--
-- On a database that has already run the queue, `pgboss` exists already,
-- owned by whichever role used to connect (smos); the explicit GRANTs below
-- hand smos_app the privileges on those existing objects. On a brand-new
-- database, `pgboss` does not exist yet; CREATE SCHEMA here (idempotent)
-- gives smos_app CREATE within a schema it already owns access to, so
-- pg-boss's own first-run bootstrap (executed as smos_app, since that is
-- the only role that will ever connect) can create its own tables without
-- needing database-wide CREATE.
CREATE SCHEMA IF NOT EXISTS pgboss;
GRANT ALL ON SCHEMA pgboss TO smos_app;
GRANT ALL ON ALL TABLES IN SCHEMA pgboss TO smos_app;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pgboss TO smos_app;
