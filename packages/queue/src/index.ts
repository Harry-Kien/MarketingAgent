// pg-boss 12 is ESM and exports the class as a named export; there is no
// default export. It also ships fromDrizzle(), which P1 will use so the
// transactional outbox can share one connection with the domain write.
import { PgBoss } from "pg-boss";

/**
 * pg-boss queue policies. Deduplication by singletonKey only happens on a
 * queue created with the "singleton" policy, so the policy is an explicit
 * argument rather than something callers have to discover.
 */
export type QueuePolicy = "standard" | "short" | "singleton" | "stately" | "exclusive";

export interface SendOptions {
  /**
   * Groups jobs for the singleton policy. Verified against pg-boss 12.27.0:
   * this alone does NOT deduplicate at send time — two sends with the same
   * key both return an id. Use singletonSeconds for deduplication.
   */
  singletonKey?: string | undefined;
  /**
   * Throttling window. A second send inside the window returns null instead
   * of an id. This is the mechanism that actually deduplicates.
   */
  singletonSeconds?: number | undefined;
}

export interface Queue {
  ensureQueue(name: string, policy?: QueuePolicy): Promise<void>;
  send(name: string, data: unknown, opts?: SendOptions): Promise<string | null>;
  work<T>(name: string, handler: (jobs: Array<{ data: T }>) => Promise<void>): Promise<string>;
  stop(): Promise<void>;
  boss: PgBoss;
}

/**
 * pg-boss runs inside the same PostgreSQL instance as the domain data
 * (ADR-003). That is what makes the transactional outbox in P1 possible:
 * enqueueing a job and writing domain rows share one transaction.
 */
export async function createQueue(url: string): Promise<Queue> {
  // `createSchema: false`: final whole-branch review, FINDING 2. Left at its
  // default (true), pg-boss's own bootstrap unconditionally issues
  // `CREATE SCHEMA IF NOT EXISTS pgboss` as part of Contractor.create's
  // single combined DDL statement -- and PostgreSQL requires CREATE ON
  // DATABASE for that statement even when the schema already exists and the
  // connecting role owns it (verified empirically). Migrations
  // (0002_smos_app_login.sql, 0003_pgboss_schema_owner.sql) already create
  // `pgboss` and make smos_app its owner before this ever runs, which is
  // sufficient on its own for every table/index/function pg-boss creates
  // inside that schema -- schema ownership grants CREATE within the schema
  // unconditionally. Disabling pg-boss's own schema-creation step is what
  // let 0020_pgboss_revoke_database_create.sql revoke the database-wide
  // CREATE grant entirely: smos_app no longer needs (and no longer has) the
  // ability to create a schema, or an un-migrated, RLS-less table,
  // ANYWHERE in the database -- only inside the one schema it already owns.
  const boss = new PgBoss({ connectionString: url, schema: "pgboss", createSchema: false });
  await boss.start();

  const ensureQueue = async (name: string, policy: QueuePolicy = "standard"): Promise<void> => {
    try {
      // The options type is Omit<Queue, "name">, so the name must not be
      // repeated inside the object.
      await boss.createQueue(name, { policy });
    } catch {
      // Already exists. pg-boss has no idempotent create, and a race between
      // two workers is expected rather than exceptional.
    }
  };

  return {
    boss,
    ensureQueue,
    async send(name, data, opts) {
      await ensureQueue(name);
      const sendOptions: Record<string, unknown> = {};
      if (opts?.singletonKey !== undefined) sendOptions["singletonKey"] = opts.singletonKey;
      if (opts?.singletonSeconds !== undefined) sendOptions["singletonSeconds"] = opts.singletonSeconds;
      return boss.send(name, data as object, sendOptions);
    },
    async work(name, handler) {
      await ensureQueue(name);
      return boss.work(name, async (jobs) => {
        await handler(jobs as unknown as Array<{ data: never }>);
      });
    },
    stop: () => boss.stop({ graceful: true }),
  };
}
