import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeZaloServer, type FakeZaloServer } from "./fake-server.ts";
import { createZaloAdapter } from "./adapter.ts";
import type { FetchLike } from "../guarded-fetch.ts";

let server: FakeZaloServer;
beforeAll(async () => {
  server = await startFakeZaloServer();
});
afterAll(async () => {
  await server.close();
});

function adapterFor(fetchImpl: FetchLike = server.fetchImpl) {
  return createZaloAdapter(
    {
      baseUrl: server.url,
      accessToken: "test-token",
      allowedHosts: ["sandbox.zalo.test"],
      getReplyWindowState: async () => ({ lastCustomerMessageAt: new Date() }),
      getComplaintRate: async () => 0,
    },
    fetchImpl,
  );
}

describe("zalo adapter contract", () => {
  it("sends a direct message and returns a channel message id", async () => {
    const adapter = adapterFor();
    const result = await adapter.sendDirectMessage({ channelContactId: "user-1", text: "xin chao", idempotencyKey: "k1" });
    expect(result.channelMessageId).toMatch(/^zmsg-/);
    expect(server.sentMessages.get(result.channelMessageId)).toEqual({ recipientId: "user-1", text: "xin chao" });
  });

  it("refuses publish outright -- Zalo OA has no safe broadcast path in this milestone", async () => {
    const adapter = adapterFor();
    await expect(
      adapter.publish({ idempotencyKey: "k2", publicationContent: "broadcast text", contentHash: "hash", targetAccountId: "oa-1" }),
    ).rejects.toMatchObject({ kind: "permanent_rejection" });
  });

  it("reports healthy when the sandbox is reachable", async () => {
    const adapter = adapterFor();
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  it("never calls fetchImpl for a host outside the allowlist", async () => {
    let calls = 0;
    const counting: FetchLike = (input, init) => {
      calls++;
      return server.fetchImpl(input, init);
    };
    const adapter = createZaloAdapter(
      {
        baseUrl: server.url,
        accessToken: "test-token",
        allowedHosts: ["someone-else.test"],
        getReplyWindowState: async () => ({ lastCustomerMessageAt: new Date() }),
        getComplaintRate: async () => 0,
      },
      counting,
    );
    await expect(
      adapter.sendDirectMessage({ channelContactId: "user-1", text: "hi", idempotencyKey: "k3" }),
    ).rejects.toThrow(/allowlist/i);
    expect(calls).toBe(0);
  });
});
