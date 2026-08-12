export { createDb, createDbPool, type Db } from "./client.ts";
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
