import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@smos/contracts";
import { createDbPool } from "@smos/db";
import { bootstrapWorker } from "./main.ts";

const env = () =>
  parseServerEnv({
    NODE_ENV: "test",
    DATABASE_URL:
      process.env["DATABASE_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos",
    // Final whole-branch review, FINDING 7: smos_worker (0017_outbox_claim_
    // token.sql) is provisioned specifically for this process's own
    // draining path and must actually be wired up, not left unused.
    DATABASE_WORKER_URL:
      process.env["DATABASE_WORKER_URL"] ?? "postgres://smos_worker:smos_worker_local_dev@127.0.0.1:5433/smos",
    OTEL_SERVICE_NAME: "smos-worker-test",
  });

describe("bootstrapWorker", () => {
  it("starts and shuts down cleanly", async () => {
    const handle = await bootstrapWorker(env());
    expect(handle.shutdown).toBeTypeOf("function");
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it("exposes the queue so later milestones can register handlers", async () => {
    const handle = await bootstrapWorker(env());
    try {
      expect(handle.queue).toBeDefined();
      expect(handle.db).toBeDefined();
    } finally {
      await handle.shutdown();
    }
  });

  it("is safe to shut down twice", async () => {
    const handle = await bootstrapWorker(env());
    await handle.shutdown();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  // Final whole-branch review, FINDING 7. smos_worker is a provisioned,
  // password-bearing LOGIN role holding this branch's highest privilege
  // (EXECUTE on outbox_claim_batch/outbox_mark_published, which reach across
  // every workspace), and nothing used it: this bootstrap connected only
  // with DATABASE_URL (smos_app). Wired up below via a second pool
  // connected with DATABASE_WORKER_URL, exposed as `drainOutbox` on the
  // handle -- draining the outbox is the one thing this codebase has that
  // actually needs smos_worker's elevated privilege, so that is what gets
  // wired, rather than leaving the role provisioned and unused.
  it("exposes drainOutbox, backed by a pool connected as smos_worker (not smos_app)", async () => {
    // A bare typeof check never asserts the role the test's own name sells.
    // Proved vacuous two ways:
    //  1) Silently rewiring main.ts's drainOutbox to the smos_app pool (a
    //     real regression -- exactly the privilege-widening FINDING 7
    //     closed) left `expect(handle.drainOutbox).toBeTypeOf("function")`
    //     green: it is still a function either way.
    //  2) A weaker fix attempt -- independently connecting over the same
    //     env.DATABASE_WORKER_URL string and checking current_user -- also
    //     stayed green under that same break, because it never touches the
    //     pool `handle.drainOutbox` itself actually closed over.
    // 0017_outbox_claim_token.sql revokes ALL on outbox_claim_batch /
    // outbox_mark_published from smos_app (smos_worker is the only role
    // granted EXECUTE), so calling outbox_claim_batch through smos_app's
    // pool throws permission-denied before it ever looks at whether there
    // is a row to claim. Actually invoking drainOutbox and asserting it
    // resolves (rather than merely checking its type) is therefore a real,
    // deterministic proof of which role backs it -- no seeded row needed.
    const handle = await bootstrapWorker(env());
    try {
      expect(handle.drainOutbox).toBeTypeOf("function");
      await expect(handle.drainOutbox(0)).resolves.toBeTypeOf("number");
    } finally {
      await handle.shutdown();
    }
  });

  it("refuses to start without DATABASE_WORKER_URL: the worker must not silently fall back to smos_app for draining", async () => {
    const badEnv = parseServerEnv({
      NODE_ENV: "test",
      DATABASE_URL: process.env["DATABASE_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos",
      OTEL_SERVICE_NAME: "smos-worker-test-no-worker-url",
    });
    await expect(bootstrapWorker(badEnv)).rejects.toThrow(/DATABASE_WORKER_URL/);
  });

  it("drains a pending outbox event end to end using the smos_worker credential", async () => {
    const handle = await bootstrapWorker(env());
    const appUrl = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
    const appPool = createDbPool(appUrl);
    // A separate pool for the final read, connected as the smos superuser
    // (bypasses RLS): reusing `appPool` here would risk pulling back a
    // pooled connection whose `app.workspace_id` GUC was touched by the
    // insert transaction above and reset to '' (not NULL) post-commit,
    // which fails `current_setting(...)::uuid` outright rather than
    // silently returning zero rows -- see cross-tenant.test.ts's identical
    // note on this exact pg pooling behaviour.
    const adminUrl =
      process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
    const adminPool = createDbPool(adminUrl);
    const workspaceId = "b0b0b0b0-b0b0-7b0b-8b0b-b0b0b0b0b0b0";
    const correlationId = "c0c0c0c0-c0c0-7c0c-8c0c-c0c0c0c0c0c0";
    try {
      await appPool.query(
        "insert into workspace (id, name) values ($1, $2) on conflict do nothing",
        [workspaceId, `worker-wiring-${Date.now()}`],
      );

      const client = await appPool.connect();
      try {
        await client.query("begin");
        await client.query("set local role smos_app");
        await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
        await client.query(
          `insert into outbox (id, workspace_id, event_type, payload, correlation_id)
           values (gen_random_uuid(), $1, $2, '{}'::jsonb, $3)`,
          [workspaceId, `test.worker-wiring.${Date.now()}`, correlationId],
        );
        await client.query("commit");
      } finally {
        client.release();
      }

      const drained = await handle.drainOutbox(50);
      expect(drained).toBeGreaterThan(0);

      const after = await adminPool.query(
        "select published_at from outbox where correlation_id = $1",
        [correlationId],
      );
      expect(after.rows[0].published_at).not.toBeNull();
    } finally {
      await appPool.end();
      await adminPool.end();
      await handle.shutdown();
    }
  });
});
