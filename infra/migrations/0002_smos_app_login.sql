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
-- Schema creation stays with smos (this migration runs as smos): CREATE
-- SCHEMA here is idempotent and, on a database that has already run the
-- queue, is a no-op against the schema smos already owns. smos_app gets
-- only USAGE on the schema -- not CREATE -- and only the DML its runtime
-- operations (send/work/getQueues, all exercised by packages/queue's
-- tests) actually issue: SELECT/INSERT/UPDATE/DELETE on tables,
-- USAGE/SELECT/UPDATE on sequences. No TRUNCATE, REFERENCES, TRIGGER, or
-- schema-level CREATE -- smos_app never issues any of those against this
-- schema. (pg-boss's own bootstrap, which can CREATE TABLE when queue
-- partitioning is enabled, is not exercised anywhere in this codebase --
-- packages/queue never passes `partition: true` -- so it needs nothing
-- more than this to do its actual job here.)
CREATE SCHEMA IF NOT EXISTS pgboss;
GRANT USAGE ON SCHEMA pgboss TO smos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO smos_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA pgboss TO smos_app;
