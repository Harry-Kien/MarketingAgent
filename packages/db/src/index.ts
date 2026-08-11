export { createDb, createDbPool, type Db } from "./client.ts";
// drainOutbox must run against a pool connected as smos_worker
// (DATABASE_WORKER_URL), never smos_app -- see outbox.ts's own header for
// why. Exported here (final whole-branch review, FINDING 7) so
// apps/worker can wire it up without an internal, package-relative import.
export { drainOutbox, enqueueInTransaction, type MinimalQueue, type OutboxEvent } from "./outbox.ts";
