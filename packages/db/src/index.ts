export { createDb, createDbPool, type Db } from "./client.ts";
// Repositories and other infrastructure code (P3's apps/web/src/server/
// queries.ts, packages/db's own repositories/) keep using the full
// TenantTx via withTenant, per tool-tx.ts's own header -- only agent tool
// bodies get the narrower, SQL-free ToolTx below. Not exporting this
// earlier was scope, not a security boundary against non-tool callers:
// packages/agents/src/runtime-db.test.ts documents the one place this stays
// deliberately withheld (the agent *runtime*, which hosts tool bodies and
// sits on the same side of the boundary tool-tx.ts draws), not application
// code that reads data on a user's behalf.
export { withTenant, type TenantTx } from "./tenant-scope.ts";
// drainOutbox must run against a pool connected as smos_worker
// (DATABASE_WORKER_URL), never smos_app -- see outbox.ts's own header for
// why. Exported here (final whole-branch review, FINDING 7) so
// apps/worker can wire it up without an internal, package-relative import.
export { drainOutbox, enqueueInTransaction, type MinimalQueue, type OutboxEvent } from "./outbox.ts";
// The narrow, non-SQL handle P2's agent tools must receive instead of
// TenantTx (see tool-tx.ts's header for why). Exported here so P2's tool
// wiring code (packages/agents) can import it as `@smos/db`, the same way
// apps/worker imports drainOutbox above, instead of reaching into this
// package's internals.
export {
  withTenantTools,
  type ToolTx,
  type ToolCampaign,
  type ToolContentItem,
  type ToolContentVersion,
  type ToolSourceCitation,
} from "./tool-tx.ts";
// The Postgres-backed RunStore T7's runtime.ts consumes -- see task-7-report.md
// requirement 1 for why this (task 10's file) was pulled forward into T7.
export { createRunStore, type RunStore } from "./repositories/run-store.ts";
