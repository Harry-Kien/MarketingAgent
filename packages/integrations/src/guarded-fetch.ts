import { assertEgressAllowed } from "./egress.ts";

/** The subset of `fetch`'s signature this module depends on -- narrow on
 * purpose so a hand-rolled fake fetch in a test doesn't need to implement
 * anything beyond what is actually used. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface GuardedFetchInit extends RequestInit {
  /** Maximum number of redirect hops to follow before giving up. Default 5. */
  maxRedirects?: number;
}

const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The redirect-safe way to call `fetch` through `assertEgressAllowed`.
 *
 * `assertEgressAllowed` only ever inspects one URL -- it has no HTTP client
 * and cannot see a redirect. If a caller passes a URL straight to `fetch`
 * with default options, `fetch` follows redirects automatically, and a
 * permitted host that answers 30x with a forbidden `Location` completely
 * defeats the guard: the caller checked the first URL, `fetch` silently
 * dialed a second, unchecked one. `guardedFetch` makes the safe path the
 * only path: it forces `redirect: "manual"` on every underlying `fetch`
 * call (overriding anything the caller passed), re-runs the *full*
 * `assertEgressAllowed` check -- allowlist included, not just the address
 * check -- on every hop's URL (the initial one and every `Location`
 * header) before following it, and bounds the number of hops so a
 * redirect loop fails instead of hanging.
 *
 * `fetchImpl` defaults to the global `fetch` and exists so tests can drive
 * this with a local fake instead of a real socket.
 */
export async function guardedFetch(
  url: string,
  allowedHosts: readonly string[],
  init?: GuardedFetchInit,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const { maxRedirects = DEFAULT_MAX_REDIRECTS, ...requestInit } = init ?? {};

  let currentUrl = url;

  for (let hop = 0; ; hop++) {
    assertEgressAllowed(currentUrl, allowedHosts);

    const response = await fetchImpl(currentUrl, { ...requestInit, redirect: "manual" });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    if (hop >= maxRedirects) {
      throw new Error(`guardedFetch: exceeded ${maxRedirects} redirects starting from ${url}`);
    }

    const location = response.headers.get("location");
    if (location === null || location === "") {
      throw new Error(`guardedFetch: redirect response (${response.status}) from ${currentUrl} had no Location header`);
    }

    // Location may be relative; resolve it against the current URL exactly
    // as a real HTTP client would, so the *resolved absolute* URL is what
    // gets re-checked on the next loop iteration -- never the raw header.
    currentUrl = new URL(location, currentUrl).href;
  }
}
