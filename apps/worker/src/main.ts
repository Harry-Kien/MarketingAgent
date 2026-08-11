import { parseServerEnv, type ServerEnv } from "@smos/contracts";
import { createDb, createDbPool, type Db } from "@smos/db";
import { createQueue, type Queue } from "@smos/queue";
import { logger, startTelemetry } from "@smos/telemetry";

export interface WorkerHandle {
  db: Db;
  queue: Queue;
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

  logger.info("worker started", { service: env.OTEL_SERVICE_NAME });

  let stopped = false;
  return {
    db,
    queue,
    async shutdown() {
      // Shutdown runs on SIGTERM and again from tests and error paths, so it
      // has to be idempotent rather than throwing on the second call.
      if (stopped) return;
      stopped = true;
      await queue.stop();
      await pool.end();
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
