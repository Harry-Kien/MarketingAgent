import type { FetchLike } from "../guarded-fetch.ts";

/**
 * A sandbox Zalo OA API double, mirroring meta/fake-server.ts's own shape
 * and its own reasoning for being in-process rather than a real
 * node:http listener: the egress guard blocks all of 127.0.0.0/8
 * unconditionally and requires https: unconditionally, so `fetchImpl` IS
 * the fake server -- no socket, TLS or plaintext is ever opened.
 */
export interface FakeZaloServer {
  /** Synthetic base URL, `.test` TLD (RFC 2606), never actually dialed. */
  url: string;
  /** messageId -> what was sent, for tests to inspect. */
  sentMessages: Map<string, { recipientId: string; text: string }>;
  fetchImpl: FetchLike;
  close(): Promise<void>;
}

const BASE_URL = "https://sandbox.zalo.test";

function envelope(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function startFakeZaloServer(): Promise<FakeZaloServer> {
  const sentMessages = new Map<string, { recipientId: string; text: string }>();
  let nextMessageId = 1;
  let closed = false;

  const fetchImpl: FetchLike = async (input, init) => {
    if (closed) throw new TypeError("fake zalo server is closed: fetch failed");

    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const token = headers.get("access_token") ?? "";

    if (token === "expired" || token === "invalid") {
      return envelope({ error: -216, message: "Access token is invalid" });
    }

    if (method === "POST" && url.pathname === "/message") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        recipient?: { user_id?: string };
        message?: { text?: string };
      };
      const recipientId = body.recipient?.user_id ?? "";
      const text = body.message?.text ?? "";
      if (recipientId === "user-rate-limited") {
        return envelope({ error: -32, message: "Rate limit exceeded" }, 429);
      }
      if (text.trim() === "") {
        return envelope({ error: -100, message: "Message text is required" });
      }
      const messageId = `zmsg-${nextMessageId++}`;
      sentMessages.set(messageId, { recipientId, text });
      return envelope({ error: 0, message: "Success", data: { message_id: messageId } });
    }

    if (method === "GET" && url.pathname === "/getprofile") {
      const data = JSON.parse(url.searchParams.get("data") ?? "{}") as { user_id?: string };
      return envelope({
        error: 0,
        message: "Success",
        data: { user_id: data.user_id, display_name: `Fake User ${String(data.user_id)}`, avatar: null },
      });
    }

    if (method === "POST" && url.pathname === "/tag/tagfollower") {
      return envelope({ error: 0, message: "Success" });
    }
    if (method === "POST" && url.pathname === "/tag/rmfollowerfromtag") {
      return envelope({ error: 0, message: "Success" });
    }
    if (method === "GET" && url.pathname === "/tag/getfollowers") {
      return envelope({ error: 0, message: "Success", data: { followers: ["user-1", "user-2"] } });
    }

    return envelope({ error: -201, message: "Method not found" }, 404);
  };

  return {
    url: BASE_URL,
    sentMessages,
    fetchImpl,
    async close() {
      closed = true;
    },
  };
}
