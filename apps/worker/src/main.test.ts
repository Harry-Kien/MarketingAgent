import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@smos/contracts";
import { bootstrapWorker } from "./main.ts";

const env = () =>
  parseServerEnv({
    NODE_ENV: "test",
    DATABASE_URL:
      process.env["DATABASE_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos",
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
});
