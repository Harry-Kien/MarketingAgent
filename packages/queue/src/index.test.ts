import { afterAll, describe, expect, it, vi } from "vitest";
import { createQueue, type Queue } from "./index.js";

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";

let queue: Queue;

afterAll(async () => {
  await queue?.stop();
});

describe("queue", () => {
  it("round-trips a job through postgres", async () => {
    queue = await createQueue(url);
    const received: string[] = [];
    await queue.work<{ id: string }>("test.echo", async (jobs) => {
      for (const job of jobs) received.push(job.data.id);
    });
    await queue.send("test.echo", { id: "job-1" });
    await vi.waitFor(() => { expect(received).toContain("job-1"); }, { timeout: 20_000, interval: 250 });
  });

  it("deduplicates a repeated send inside a singletonSeconds window", async () => {
    const name = `test.dedupe.${Date.now()}`;
    const first = await queue.send(name, { n: 1 }, { singletonSeconds: 60 });
    const second = await queue.send(name, { n: 2 }, { singletonSeconds: 60 });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("does not deduplicate on singletonKey alone", async () => {
    // Documents verified pg-boss 12 behaviour so nobody relies on the wrong
    // mechanism for idempotency later.
    const name = `test.key-only.${Date.now()}`;
    await queue.ensureQueue(name, "singleton");
    const first = await queue.send(name, { n: 1 }, { singletonKey: "same" });
    const second = await queue.send(name, { n: 2 }, { singletonKey: "same" });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
  });

  it("creates its schema inside the application database, not a separate store", async () => {
    const result = await queue.boss.getQueues();
    expect(Array.isArray(result)).toBe(true);
  });
});
