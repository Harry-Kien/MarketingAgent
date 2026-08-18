import { describe, expect, it } from "vitest";
import { createZaloClient } from "./client.ts";
import type { FetchLike } from "../guarded-fetch.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("zalo client", () => {
  it("sends a message and returns the channel message id, over the allowlisted host only", async () => {
    let calls = 0;
    const fakeFetch: FetchLike = async (input, init) => {
      calls++;
      const url = new URL(String(input));
      expect(url.hostname).toBe("sandbox.zalo.test");
      expect(url.pathname).toBe("/message");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("access_token")).toBe("test-token");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ recipient: { user_id: "u1" }, message: { text: "hi" } });
      return jsonResponse({ error: 0, message: "Success", data: { message_id: "msg-1" } });
    };
    const client = createZaloClient(
      { baseUrl: "https://sandbox.zalo.test", accessToken: "test-token", allowedHosts: ["sandbox.zalo.test"] },
      fakeFetch,
    );
    const result = await client.sendMessage("u1", "hi");
    expect(result).toEqual({ messageId: "msg-1" });
    expect(calls).toBe(1);
  });

  it("surfaces an invalid/expired access token (error -216) as auth_expired, non-retryable", async () => {
    const fakeFetch: FetchLike = async () => jsonResponse({ error: -216, message: "Access token is invalid" });
    const client = createZaloClient(
      { baseUrl: "https://sandbox.zalo.test", accessToken: "bad-token", allowedHosts: ["sandbox.zalo.test"] },
      fakeFetch,
    );
    await expect(client.sendMessage("u1", "hi")).rejects.toMatchObject({ kind: "auth_expired", retryable: false });
  });

  it("surfaces an HTTP 429 as rate_limited, retryable", async () => {
    const fakeFetch: FetchLike = async () => jsonResponse({ error: -32, message: "Rate limit exceeded" }, 429);
    const client = createZaloClient(
      { baseUrl: "https://sandbox.zalo.test", accessToken: "test-token", allowedHosts: ["sandbox.zalo.test"] },
      fakeFetch,
    );
    await expect(client.sendMessage("u1", "hi")).rejects.toMatchObject({ kind: "rate_limited", retryable: true });
  });

  it("fetches a follower's profile", async () => {
    const fakeFetch: FetchLike = async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/getprofile");
      expect(JSON.parse(url.searchParams.get("data")!)).toEqual({ user_id: "u1" });
      return jsonResponse({
        error: 0,
        message: "Success",
        data: { user_id: "u1", display_name: "Nguyen Van A", avatar: "https://cdn.zalo.test/a.png" },
      });
    };
    const client = createZaloClient(
      { baseUrl: "https://sandbox.zalo.test", accessToken: "test-token", allowedHosts: ["sandbox.zalo.test"] },
      fakeFetch,
    );
    await expect(client.getProfile("u1")).resolves.toEqual({
      userId: "u1",
      displayName: "Nguyen Van A",
      avatar: "https://cdn.zalo.test/a.png",
    });
  });

  it("tags a follower", async () => {
    let calls = 0;
    const fakeFetch: FetchLike = async (input, init) => {
      calls++;
      const url = new URL(String(input));
      expect(url.pathname).toBe("/tag/tagfollower");
      expect(JSON.parse(String(init?.body))).toEqual({ user_id: "u1", tag_name: "vip" });
      return jsonResponse({ error: 0, message: "Success" });
    };
    const client = createZaloClient(
      { baseUrl: "https://sandbox.zalo.test", accessToken: "test-token", allowedHosts: ["sandbox.zalo.test"] },
      fakeFetch,
    );
    await client.tagFollower("u1", "vip");
    expect(calls).toBe(1);
  });

  it("removes a follower tag", async () => {
    const fakeFetch: FetchLike = async (input, init) => {
      expect(new URL(String(input)).pathname).toBe("/tag/rmfollowerfromtag");
      expect(JSON.parse(String(init?.body))).toEqual({ user_id: "u1", tag_name: "vip" });
      return jsonResponse({ error: 0, message: "Success" });
    };
    const client = createZaloClient(
      { baseUrl: "https://sandbox.zalo.test", accessToken: "test-token", allowedHosts: ["sandbox.zalo.test"] },
      fakeFetch,
    );
    await expect(client.removeFollowerTag("u1", "vip")).resolves.toBeUndefined();
  });

  it("lists followers by tag", async () => {
    const fakeFetch: FetchLike = async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/tag/getfollowers");
      expect(JSON.parse(url.searchParams.get("data")!)).toEqual({ tag_name: "vip" });
      return jsonResponse({ error: 0, message: "Success", data: { followers: ["u1", "u2"] } });
    };
    const client = createZaloClient(
      { baseUrl: "https://sandbox.zalo.test", accessToken: "test-token", allowedHosts: ["sandbox.zalo.test"] },
      fakeFetch,
    );
    await expect(client.listFollowersByTag("vip")).resolves.toEqual(["u1", "u2"]);
  });

  it("never calls fetchImpl for a host outside the allowlist -- guardedFetch refuses first", async () => {
    let calls = 0;
    const fakeFetch: FetchLike = async () => {
      calls++;
      return jsonResponse({ error: 0, message: "Success", data: { message_id: "unreachable" } });
    };
    const client = createZaloClient(
      { baseUrl: "https://sandbox.zalo.test", accessToken: "t", allowedHosts: ["someone-else.test"] },
      fakeFetch,
    );
    await expect(client.sendMessage("u1", "hi")).rejects.toThrow(/allowlist/i);
    expect(calls).toBe(0);
  });
});
