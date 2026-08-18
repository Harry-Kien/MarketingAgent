import { describe, expect, it } from "vitest";
import { startFakeZaloServer, type FakeZaloServer } from "./fake-server.ts";
import { createZaloAdapter } from "./adapter.ts";
import { ReplyWindowClosedError } from "./reply-window.ts";
import type { FetchLike } from "../guarded-fetch.ts";

describe("zalo adapter -- ban avoidance gate", () => {
  it("refuses to send outside the reply window before any HTTP call is made", async () => {
    const server: FakeZaloServer = await startFakeZaloServer();
    let calls = 0;
    const countingFetch: FetchLike = (input, init) => {
      calls++;
      return server.fetchImpl(input, init);
    };
    const adapter = createZaloAdapter(
      {
        baseUrl: server.url,
        accessToken: "test-token",
        allowedHosts: ["sandbox.zalo.test"],
        getReplyWindowState: async () => ({ lastCustomerMessageAt: null }),
        getComplaintRate: async () => 0,
      },
      countingFetch,
    );
    await expect(
      adapter.sendDirectMessage({ channelContactId: "user-1", text: "xin chao", idempotencyKey: "k1" }),
    ).rejects.toBeInstanceOf(ReplyWindowClosedError);
    expect(calls).toBe(0);
    await server.close();
  });

  it("refuses to send once the complaint rate is at or above the configured threshold, before any HTTP call is made", async () => {
    const server: FakeZaloServer = await startFakeZaloServer();
    let calls = 0;
    const countingFetch: FetchLike = (input, init) => {
      calls++;
      return server.fetchImpl(input, init);
    };
    const recent = new Date();
    const adapter = createZaloAdapter(
      {
        baseUrl: server.url,
        accessToken: "test-token",
        allowedHosts: ["sandbox.zalo.test"],
        getReplyWindowState: async () => ({ lastCustomerMessageAt: recent }),
        getComplaintRate: async () => 0.03,
      },
      countingFetch,
    );
    await expect(
      adapter.sendDirectMessage({ channelContactId: "user-1", text: "xin chao", idempotencyKey: "k2" }),
    ).rejects.toThrow(/spam-complaint rate/);
    expect(calls).toBe(0);
    await server.close();
  });

  it("sends successfully when inside the window and below the complaint threshold", async () => {
    const server: FakeZaloServer = await startFakeZaloServer();
    const recent = new Date();
    const adapter = createZaloAdapter(
      {
        baseUrl: server.url,
        accessToken: "test-token",
        allowedHosts: ["sandbox.zalo.test"],
        getReplyWindowState: async () => ({ lastCustomerMessageAt: recent }),
        getComplaintRate: async () => 0.001,
      },
      server.fetchImpl,
    );
    const result = await adapter.sendDirectMessage({ channelContactId: "user-1", text: "xin chao", idempotencyKey: "k3" });
    expect(result.channelMessageId).toMatch(/^zmsg-/);
    await server.close();
  });
});
