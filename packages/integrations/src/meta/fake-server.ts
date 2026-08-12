import type { FetchLike } from "../guarded-fetch.ts";

/**
 * A sandbox Graph v23 double for the Meta adapter, so publish, retry-shape,
 * and error-mapping behaviour can all be tested without ever contacting the
 * real Meta API (invariant #11: Meta is sandbox/dry-run only, no real
 * credentials, no network egress -- ever, in code or tests).
 *
 * Deliberately in-process, not a real `node:http`/`node:https` listener --
 * see the long comment at the top of `contract.test.ts` for why: the
 * egress guard this adapter is required to route through
 * (`assertEgressAllowed`, via `guardedFetch`) blocks the entire
 * 127.0.0.0/8 loopback range unconditionally, before it even looks at an
 * allowlist, and requires `https:` unconditionally. A real server bound to
 * 127.0.0.1 can never pass that guard on any protocol, and standing up a
 * real TLS listener with a certificate the guard's/undici's default trust
 * store would accept is exactly the kind of real-network-adjacent
 * complexity (and, absent an approved new dependency, effectively
 * impossible) the task's "no real outbound network request, ever" and
 * "avoid new dependencies" constraints rule out. Instead, `fetchImpl`
 * IS the fake server: `createMetaAdapter` calls `guardedFetch(url,
 * allowedHosts, init, fetchImpl)` exactly as it would in production
 * (`fetchImpl` defaulting to the real global `fetch` there), just with
 * this function swapped in for tests. No socket, TLS or plaintext, is ever
 * opened by this file. `url` is a synthetic, domain-name-shaped hostname
 * (`sandbox.meta.test`, from the IANA-reserved-for-testing `.test` TLD --
 * RFC 2606 -- guaranteed to never resolve to anything real) so it takes
 * the same "plain domain name, not an IP literal" pass-through through
 * `assertResolvedAddressAllowed` that a real `graph.facebook.com` call
 * would, while the https-only check and the allowlist check are still
 * genuinely exercised end to end.
 */
export interface FakeMetaServer {
  /** Synthetic base URL. Never actually dialed -- see the module comment. */
  url: string;
  /** externalId -> stored post body, for tests to inspect. */
  posts: Map<string, unknown>;
  /** Drive `createMetaAdapter`'s calls through this instead of a real socket. */
  fetchImpl: FetchLike;
  close(): Promise<void>;
}

const BASE_URL = "https://sandbox.meta.test";

interface GraphErrorBody {
  error: { message: string; type: string; code: number };
}

function graphError(status: number, message: string, type: string, code: number, extraHeaders?: Record<string, string>): Response {
  const body: GraphErrorBody = { error: { message, type, code } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

/** Waits `ms`, but rejects immediately (or as soon as it fires) if `signal` aborts -- so an adapter-side timeout genuinely wins the race instead of the fake server's delay masking it. */
function delay(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      },
      { once: true },
    );
  });
}

export async function startFakeMetaServer(): Promise<FakeMetaServer> {
  const posts = new Map<string, unknown>();
  const idempotencyIndex = new Map<string, string>();
  let nextId = 1;
  let closed = false;

  const fetchImpl: FetchLike = async (input, init) => {
    if (closed) {
      throw new TypeError("fake meta server is closed: fetch failed");
    }

    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const signal = init?.signal ?? undefined;

    if (method === "GET" && url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
    }

    // Every publish call is POST /<pageId>/feed with a JSON body -- the one
    // route this sandbox actually implements.
    if (method !== "POST" || !/^\/[^/]+\/feed$/.test(url.pathname)) {
      return graphError(404, "Unsupported post request. Object does not exist.", "GraphMethodException", 100);
    }

    const pageIdFromPath = url.pathname.split("/")[1] ?? "";

    const headers = new Headers(init?.headers);
    const authHeader = headers.get("authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");

    let parsedBody: {
      message?: unknown;
      idempotencyKey?: unknown;
      targetAccountId?: unknown;
    };
    try {
      parsedBody = JSON.parse(String(init?.body ?? "{}"));
    } catch {
      return graphError(400, "Malformed request body", "GraphMethodException", 100);
    }

    const message = typeof parsedBody.message === "string" ? parsedBody.message : "";
    const idempotencyKey = typeof parsedBody.idempotencyKey === "string" ? parsedBody.idempotencyKey : "";
    const targetAccountId = typeof parsedBody.targetAccountId === "string" ? parsedBody.targetAccountId : "";

    // 1. Auth check first -- an expired/invalid token fails regardless of
    // which account or content is being posted. The sandbox echoes the
    // presented token back into the message, mirroring a real, documented
    // Meta behaviour (see errors.ts) -- this is deliberate, so the
    // adapter's redaction can be tested against a message that genuinely
    // contains a live-looking secret, not one that never had one to redact.
    if (token === "expired") {
      return graphError(401, `Error validating access token: the session for token "${token}" has expired`, "OAuthException", 190);
    }
    if (token === "invalid" || token === "") {
      // Real Meta behaviour: an unrecognised/malformed token comes back as
      // the same OAuthException code as an expired session -- there is no
      // separate wire-level signal to distinguish them.
      return graphError(401, `Error validating access token: the token "${token}" is not a valid access token`, "OAuthException", 190);
    }

    // 2. Account-driven scenario routing -- lets a test pick a specific
    // failure mode via `targetAccountId` without needing a different
    // adapter/token per scenario.
    switch (targetAccountId) {
      case "page-rate-limited":
        return graphError(429, `Application request limit reached (token "${token}")`, "OAuthException", 4, { "retry-after": "5" });
      case "page-rate-limited-bad-header":
        return graphError(429, "Application request limit reached", "OAuthException", 4, { "retry-after": "not-a-number" });
      case "page-quota-exceeded":
        return graphError(403, "Ad account has reached its spending/quota limit", "OAuthException", 80004);
      case "page-upstream-down":
        return graphError(503, "Service temporarily unavailable", "OAuthException", 2);
      case "page-not-found":
        return graphError(404, "Unsupported post request. Object with that ID does not exist.", "GraphMethodException", 100);
      case "page-redirect-trap":
        // A real cloud-metadata-shaped internal address. This must never
        // actually be reached -- guardedFetch is required to re-run the
        // full egress guard on this Location header before following it,
        // which throws before this file's fetchImpl is ever called again.
        return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/" } });
      case "page-malformed":
        // A broken/misbehaving upstream: 200 status, but the body is not
        // valid JSON despite a JSON content-type -- must not be read as a
        // fake success.
        return new Response("not-json{{", { status: 200, headers: { "content-type": "application/json" } });
      case "page-slow":
        await delay(200, signal);
        break; // falls through to the normal success path below
      default:
        break;
    }

    // 3. Payload validation.
    if (message.trim() === "") {
      return graphError(400, "(#100) Param message must not be empty", "GraphMethodException", 100);
    }

    // 4. Idempotent success: replay the same result for a repeated key
    // instead of creating a second post.
    const existingId = idempotencyIndex.get(idempotencyKey);
    if (existingId !== undefined) {
      return new Response(JSON.stringify({ id: existingId, requestId: `req-${existingId}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const id = `${pageIdFromPath}_${nextId++}`;
    posts.set(id, { message, targetAccountId });
    if (idempotencyKey !== "") idempotencyIndex.set(idempotencyKey, id);

    return new Response(JSON.stringify({ id, requestId: `req-${id}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  return {
    url: BASE_URL,
    posts,
    fetchImpl,
    async close() {
      closed = true;
    },
  };
}
