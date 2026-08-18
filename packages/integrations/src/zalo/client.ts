import { guardedFetch, type FetchLike } from "../guarded-fetch.ts";
import { AdapterError, type ErrorKind } from "../errors.ts";

export interface ZaloClientConfig {
  baseUrl: string;
  accessToken: string;
  allowedHosts: string[];
  /** Milliseconds to wait for a response before treating the call as
   * `upstream_unavailable`. Default 10000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

// Zalo OA's own well-documented sentinel for an invalid/expired access
// token (its OA API error-code reference, `error: -216`). Every other
// nonzero `error` code maps to permanent_rejection below -- unlike Meta's
// Graph API, Zalo's OA API returns HTTP 200 for almost every API-level
// failure and signals it through this body field instead, so a caller
// cannot rely on HTTP status alone. This single code is the one piece of
// that mapping used here; verify the fuller code table against a live
// sandbox Official Account before this client reaches a real customer --
// flagged unverified the same way the design spec flags D5's legal claim.
const ZALO_INVALID_TOKEN_ERROR_CODE = -216;

interface ZaloEnvelope<T> {
  error: number;
  message: string;
  data?: T;
}

function mapZaloFailureToKind(httpStatus: number, bodyErrorCode: number | null): ErrorKind {
  if (httpStatus === 401 || httpStatus === 403) return "auth_expired";
  if (httpStatus === 429) return "rate_limited";
  if (httpStatus >= 500) return "upstream_unavailable";
  if (httpStatus >= 400) return "invalid_input";
  if (bodyErrorCode === ZALO_INVALID_TOKEN_ERROR_CODE) return "auth_expired";
  return "permanent_rejection";
}

export interface ZaloProfile {
  userId: string;
  displayName: string;
  avatar: string | null;
}

export interface ZaloClient {
  sendMessage(recipientId: string, text: string): Promise<{ messageId: string }>;
  getProfile(userId: string): Promise<ZaloProfile>;
  tagFollower(userId: string, tagName: string): Promise<void>;
  removeFollowerTag(userId: string, tagName: string): Promise<void>;
  listFollowersByTag(tagName: string): Promise<string[]>;
}

/**
 * Typed client for the Zalo OA API, pointed at either the real API or the
 * in-process sandbox from `fake-server.ts` (`fetchImpl` swapped for tests).
 * Every outbound call goes through `guardedFetch`, never a bare `fetch` --
 * see meta/client.ts's own header for why that matters (the allowlist and
 * the redirect-safety re-check are only genuinely enforced when every hop
 * goes through it).
 */
export function createZaloClient(cfg: ZaloClientConfig, fetchImpl: FetchLike = fetch): ZaloClient {
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T = undefined>(path: string, method: string, body?: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      const requestInit: Parameters<typeof guardedFetch>[2] = {
        method,
        headers: body
          ? { "content-type": "application/json", access_token: cfg.accessToken }
          : { access_token: cfg.accessToken },
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (body) requestInit.body = JSON.stringify(body);
      response = await guardedFetch(`${cfg.baseUrl}${path}`, cfg.allowedHosts, requestInit, fetchImpl);
    } catch (err) {
      if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new AdapterError("upstream_unavailable", `Zalo request to ${path} timed out after ${timeoutMs}ms`);
      }
      // The egress guard refusing this call outright (bad protocol, host
      // not on the allowlist, blocked address) -- non-retryable, since
      // retrying the identical call hits the same guard refusal again.
      throw new AdapterError("permanent_rejection", err instanceof Error ? err.message : String(err));
    }

    const text = await response.text();
    let json: unknown = null;
    if (text !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        throw new AdapterError(
          "upstream_unavailable",
          `Zalo returned a non-JSON response (status ${response.status}): ${text.slice(0, 200)}`,
        );
      }
    }

    const envelope = json as Partial<ZaloEnvelope<T>> | null;
    const bodyErrorCode = envelope && typeof envelope.error === "number" ? envelope.error : null;

    if (!response.ok || bodyErrorCode === null || bodyErrorCode !== 0) {
      const kind = mapZaloFailureToKind(response.status, bodyErrorCode);
      const message =
        envelope && typeof envelope.message === "string" ? envelope.message : `Zalo call to ${path} failed (status ${response.status})`;
      throw new AdapterError(kind, message);
    }

    return (envelope?.data ?? undefined) as T;
  }

  return {
    async sendMessage(recipientId, text) {
      const data = await call<{ message_id: string }>("/message", "POST", {
        recipient: { user_id: recipientId },
        message: { text },
      });
      if (!data || typeof data.message_id !== "string" || data.message_id === "") {
        throw new AdapterError("upstream_unavailable", "Zalo sendMessage response was missing a message id");
      }
      return { messageId: data.message_id };
    },

    async getProfile(userId) {
      const data = await call<{ user_id: string; display_name: string; avatar?: string }>(
        `/getprofile?data=${encodeURIComponent(JSON.stringify({ user_id: userId }))}`,
        "GET",
      );
      if (!data || typeof data.user_id !== "string" || typeof data.display_name !== "string") {
        throw new AdapterError("upstream_unavailable", "Zalo getProfile response was missing required fields");
      }
      return { userId: data.user_id, displayName: data.display_name, avatar: data.avatar ?? null };
    },

    async tagFollower(userId, tagName) {
      await call("/tag/tagfollower", "POST", { user_id: userId, tag_name: tagName });
    },

    async removeFollowerTag(userId, tagName) {
      await call("/tag/rmfollowerfromtag", "POST", { user_id: userId, tag_name: tagName });
    },

    async listFollowersByTag(tagName) {
      const data = await call<{ followers: string[] }>(
        `/tag/getfollowers?data=${encodeURIComponent(JSON.stringify({ tag_name: tagName }))}`,
        "GET",
      );
      return data?.followers ?? [];
    },
  };
}
