import { guardedFetch, type FetchLike } from "../guarded-fetch.ts";
import { AdapterError, type ErrorKind } from "../errors.ts";
import type { ChannelAdapter, PublishInput, PublishResult } from "../adapter.ts";

export interface MetaAdapterConfig {
  baseUrl: string;
  pageId: string;
  token: string;
  allowedHosts: string[];
  /** Milliseconds to wait for a response before treating the call as
   * `upstream_unavailable`. Default 10000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

interface GraphErrorBody {
  error?: { message?: unknown; type?: unknown; code?: unknown };
}

/**
 * Maps an HTTP status from the (real or sandboxed) Graph API onto the
 * six-kind taxonomy an operator/retry-policy needs to distinguish. See
 * the mapping table in the track report for the full status <-> Graph
 * error-code <-> ErrorKind correspondence this mirrors.
 */
function mapStatusToKind(status: number): ErrorKind {
  if (status === 401) return "auth_expired";
  if (status === 429) return "rate_limited";
  if (status === 403) return "quota_exceeded";
  if (status === 400) return "invalid_input";
  if (status >= 500) return "upstream_unavailable";
  // Any other non-2xx (404, 409, ...): nothing about it is "try again
  // later" or "fix the input and resubmit" -- treat as permanent.
  return "permanent_rejection";
}

function extractGraphMessage(json: unknown, fallback: string): string {
  if (json && typeof json === "object" && "error" in json) {
    const err = (json as GraphErrorBody).error;
    if (err && typeof err.message === "string") return err.message;
  }
  return fallback;
}

/**
 * Typed client for Meta's Graph API, pointed at either the real API
 * (`baseUrl: "https://graph.facebook.com"`, real global `fetch`) or the
 * in-process sandbox from `fake-server.ts` (`fetchImpl` swapped for
 * tests). Every outbound call goes through `guardedFetch`, never a bare
 * `fetch` -- so the egress allowlist and the redirect-safety re-check are
 * genuinely enforced on every hop, including the initial URL and every
 * `Location` header, no matter which `baseUrl` is configured.
 *
 * `fetchImpl` defaults to the real global `fetch`, exactly like
 * `guardedFetch` itself -- it exists purely so a test (or, one day, a
 * different transport) can swap it, not so callers have to think about it.
 */
export function createMetaAdapter(cfg: MetaAdapterConfig, fetchImpl: FetchLike = fetch): ChannelAdapter {
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function callGraph(path: string, method: string, body?: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
    let response: Response;
    try {
      const requestInit: Parameters<typeof guardedFetch>[2] = {
        method,
        headers: body
          ? { "content-type": "application/json", authorization: `Bearer ${cfg.token}` }
          : { authorization: `Bearer ${cfg.token}` },
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (body) requestInit.body = JSON.stringify(body);

      response = await guardedFetch(`${cfg.baseUrl}${path}`, cfg.allowedHosts, requestInit, fetchImpl);
    } catch (err) {
      if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new AdapterError("upstream_unavailable", `Meta sandbox request to ${path} timed out after ${timeoutMs}ms`);
      }
      // Anything else thrown here is the egress guard refusing this call
      // outright (bad protocol, host not on the allowlist, or a blocked
      // address -- including a redirect Location that failed the exact
      // same re-check) before any HTTP response ever existed to
      // interpret. The guard's own error message only ever mentions the
      // URL/hostname, never `cfg.token`, so it is safe to surface as-is --
      // still routed through AdapterError so a caller only ever has to
      // catch one error shape from a ChannelAdapter. This is
      // non-retryable: retrying the identical call would hit the exact
      // same guard refusal again.
      throw new AdapterError("permanent_rejection", err instanceof Error ? err.message : String(err));
    }

    const text = await response.text();
    let json: unknown = null;
    if (text !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        // A 2xx or non-2xx response whose body isn't valid JSON is a
        // broken/misbehaving upstream, not a validation problem with our
        // own request and not something a fixed input could ever resolve
        // -- closest in shape to a transient outage.
        throw new AdapterError(
          "upstream_unavailable",
          `Meta sandbox returned a non-JSON response (status ${response.status}): ${text.slice(0, 200)}`,
        );
      }
    }

    if (!response.ok) {
      const kind = mapStatusToKind(response.status);
      const message = extractGraphMessage(json, `Meta sandbox returned ${response.status}`);
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterSeconds = retryAfterHeader !== null ? Number(retryAfterHeader) : NaN;
      const opts: { retryAfterMs?: number } = {};
      // A non-numeric or missing Retry-After must NOT become a NaN
      // retryAfterMs -- a downstream retry scheduler treating NaN as a
      // backoff duration could retry immediately and repeatedly, which is
      // worse than carrying no hint at all.
      if (kind === "rate_limited" && Number.isFinite(retryAfterSeconds)) {
        opts.retryAfterMs = retryAfterSeconds * 1000;
      }
      throw new AdapterError(kind, message, opts);
    }

    return { status: response.status, json };
  }

  return {
    name: "meta",

    async healthCheck(): Promise<boolean> {
      try {
        const { status } = await callGraph("/health", "GET");
        return status >= 200 && status < 300;
      } catch {
        return false;
      }
    },

    async publish(input: PublishInput): Promise<PublishResult> {
      const { json } = await callGraph(`/${cfg.pageId}/feed`, "POST", {
        message: input.publicationContent,
        idempotencyKey: input.idempotencyKey,
        targetAccountId: input.targetAccountId,
        contentHash: input.contentHash,
      });

      const record = json as { id?: unknown; requestId?: unknown };
      if (typeof record?.id !== "string" || record.id === "") {
        throw new AdapterError("upstream_unavailable", "Meta sandbox response was missing a post id");
      }

      return {
        externalId: record.id,
        permalink: `https://facebook.com/${record.id}`,
        evidence: {
          requestId: typeof record.requestId === "string" ? record.requestId : null,
          status: 200,
        },
      };
    },

    async sendDirectMessage(_input: { channelContactId: string; text: string; idempotencyKey: string }): Promise<{ channelMessageId: string }> {
      // M2B widened ChannelAdapter with sendDirectMessage; Meta's Page feed
      // channel has no direct-message send path implemented in this
      // milestone (D1: only Zalo OA does). Refused outright rather than
      // silently no-op'd, so a caller cannot mistake "did nothing" for
      // "sent".
      throw new AdapterError("permanent_rejection", "Meta channel adapter does not implement sendDirectMessage in this milestone; use publish");
    },
  };
}
