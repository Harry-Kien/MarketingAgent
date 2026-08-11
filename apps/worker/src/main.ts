import { parseServerEnv, type ServerEnv } from "@smos/contracts";
import { createDb, createDbPool, drainOutbox, type Db } from "@smos/db";
import { createQueue, type Queue } from "@smos/queue";
import { logger, startTelemetry } from "@smos/telemetry";

export interface WorkerHandle {
  db: Db;
  queue: Queue;
  /**
   * Drains up to `batchSize` pending outbox rows across every workspace in
   * one pass, via the smos_worker credential (DATABASE_WORKER_URL) -- never
   * `db`'s own pool, which connects as smos_app and has no EXECUTE on
   * either function this needs (0017_outbox_claim_token.sql). See
   * packages/db/src/outbox.ts's drainOutbox for the full contract.
   */
  drainOutbox(batchSize?: number): Promise<number>;
  shutdown(): Promise<void>;
}

export async function bootstrapWorker(env: ServerEnv): Promise<WorkerHandle> {
  // Telemetry starts first so the auto-instrumentation hooks are in place
  // before the pg pool and the queue create any connections.
  const stopTelemetry = await startTelemetry({
    serviceName: env.OTEL_SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  const pool = createDbPool(env.DATABASE_URL);
  const db = createDb(pool);
  const queue = await createQueue(env.DATABASE_URL);

  // Final whole-branch review, FINDING 7: smos_worker (0017_outbox_claim_
  // token.sql) is a provisioned, password-bearing LOGIN role holding this
  // branch's highest privilege (EXECUTE on outbox_claim_batch /
  // outbox_mark_published, reaching across every workspace) and nothing
  // used it -- this bootstrap connected only with DATABASE_URL (smos_app).
  // Required, not optional: falling back to smos_app here would silently
  // reintroduce the exact privilege-widening 0017's fix round 1 closed
  // (smos_app itself has no EXECUTE on either function at all -- draining
  // would just fail -- so failing loudly here, before ever calling
  // drainOutbox, is a clearer error than a permission-denied surprise
  // later).
  if (env.DATABASE_WORKER_URL === undefined) {
    await queue.stop();
    await pool.end();
    await stopTelemetry();
    throw new Error(
      "bootstrapWorker: DATABASE_WORKER_URL is not set. The worker drains the " +
        "outbox as smos_worker, a separate credential from DATABASE_URL's " +
        "smos_app (see .env.example) -- set DATABASE_WORKER_URL and retry.",
    );
  }
  const workerPool = createDbPool(env.DATABASE_WORKER_URL);

  logger.info("worker started", { service: env.OTEL_SERVICE_NAME });

  let stopped = false;
  return {
    db,
    queue,
    drainOutbox: (batchSize?: number) => drainOutbox(workerPool, queue, batchSize),
    async shutdown() {
      // Shutdown runs on SIGTERM and again from tests and error paths, so it
      // has to be idempotent rather than throwing on the second call.
      if (stopped) return;
      stopped = true;
      await queue.stop();
      await pool.end();
      await workerPool.end();
      await stopTelemetry();
      logger.info("worker stopped");
    },
  };
}

// Only run when executed directly, so importing this module in a test has no
// side effects.
if (process.argv[1]?.endsWith("main.js") === true) {
  const handle = await bootstrapWorker(parseServerEnv(process.env));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void handle.shutdown().then(() => process.exit(0));
    });
  }
}
