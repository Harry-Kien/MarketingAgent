import type pg from "pg";

/**
 * Hardening task 1. See infra/migrations/0035_webhook_rate_limit.sql's
 * header for the full design reasoning (fixed-cardinality hash buckets,
 * reset-in-place rows, four disjoint scopes). This module is the one place
 * that talks to `webhook_rate_limit_bucket`.
 *
 * `buckets` (the hash modulus, N) is a FIXED, per-scope, INTERNAL constant
 * -- never a caller-supplied parameter, for any caller, including tests.
 * The reason is a real bug this design specifically avoids: `bucket_index`
 * is `hash(key) % N`, so if two different call sites ever used a different
 * N for the SAME scope, they would address the SAME physical
 * `(scope, bucket_index)` primary key through two different, disagreeing
 * hash spaces -- a low-N caller could silently plant a row at an index a
 * high-N caller's real traffic maps to, corrupting that unrelated key's
 * budget. Keeping N fixed per scope makes that impossible by construction.
 * `limit` and `windowSeconds`, in contrast, do not affect which row a key
 * addresses (only how a given row's `request_count`/`window_start` are
 * interpreted once found), so `checkRateLimitBucket` below safely accepts
 * them as parameters -- this is what lets webhook-rate-limit.test.ts drive
 * a real, fast window-reset proof against real Postgres without needing a
 * dedicated test-only scope.
 */
export type WebhookRateLimitScope = "valid_workspace" | "invalid_ip" | "invalid_workspace" | "invalid_global";

const BUCKETS_BY_SCOPE: Record<WebhookRateLimitScope, number> = {
  // 1021 is prime (reduces collision clustering vs. a round number) and
  // large enough that real traffic volumes in this milestone essentially
  // never collide, while still being a genuinely FIXED ceiling on row count
  // regardless of how many distinct keys (workspace ids, IPs) are ever seen.
  valid_workspace: 1021,
  invalid_ip: 1021,
  invalid_workspace: 1021,
  // The whole point of "global" is one shared counter: N=1 means
  // hash(key) % 1 is always 0, so every call -- whatever key it is passed --
  // addresses the single row (invalid_global, 0).
  invalid_global: 1,
};

export interface WebhookRateLimitConfig {
  limit: number;
  windowSeconds: number;
}

/**
 * Hardening task 1's own budgets. All four scopes share one 60s fixed
 * window; deliberately different LIMITS per scope, reasoned through in
 * 0035's header:
 *
 *  - valid_workspace is generous (2/sec sustained) because it is the only
 *    scope a legitimate sender's traffic can ever touch, and can ONLY be
 *    incremented by a request that already passed HMAC verification under
 *    that workspace's own derived secret -- an attacker forging signatures
 *    can never write into it, for any workspace, so no amount of forged
 *    traffic can ever exhaust a real sender's own budget here.
 *  - invalid_ip / invalid_workspace / invalid_global are all tight: nothing
 *    with a correct secret should ever land here more than a handful of
 *    times (a genuine misconfiguration, not sustained traffic), so a low
 *    ceiling costs real senders nothing while stopping abuse fast.
 */
export const WEBHOOK_RATE_LIMITS: Record<WebhookRateLimitScope, WebhookRateLimitConfig> = {
  valid_workspace: { limit: 120, windowSeconds: 60 },
  invalid_ip: { limit: 10, windowSeconds: 60 },
  invalid_workspace: { limit: 20, windowSeconds: 60 },
  invalid_global: { limit: 200, windowSeconds: 60 },
};

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until this bucket's window resets. 0 when `allowed` is true. */
  retryAfterSeconds: number;
}

// bigint cast before abs(): hashtext() returns a plain int4, and Postgres's
// int4 abs() throws "integer out of range" on exactly one input (INT_MIN,
// whose negation does not fit back into int4). The chance of an attacker
// hitting that one hash value is astronomically low, but the fix is a free
// cast, not a real trade-off, so there is no reason to leave a live crash
// path an attacker's own chosen key could technically trigger.
const UPSERT_SQL = `
  insert into webhook_rate_limit_bucket (scope, bucket_index, window_start, request_count)
  values ($1, abs(hashtext($2)::bigint) % $3, now(), 1)
  on conflict (scope, bucket_index) do update set
    request_count = case
      when webhook_rate_limit_bucket.window_start <= now() - make_interval(secs => $4::double precision)
        then 1
      else webhook_rate_limit_bucket.request_count + 1
    end,
    window_start = case
      when webhook_rate_limit_bucket.window_start <= now() - make_interval(secs => $4::double precision)
        then now()
      else webhook_rate_limit_bucket.window_start
    end
  returning request_count, window_start
`;

function computeRetryAfterSeconds(windowStart: Date, windowSeconds: number): number {
  const elapsedMs = Date.now() - windowStart.getTime();
  const remainingMs = windowSeconds * 1000 - elapsedMs;
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

/**
 * The raw primitive: one atomic UPSERT (no read-then-write race window),
 * scoped to whatever `scope`'s fixed bucket count is. Exported so
 * webhook-rate-limit.test.ts can prove the mechanism itself (increment,
 * limit enforcement, time-based reset, hash-collision sharing) directly
 * against real Postgres, with a custom `limit`/`windowSeconds` -- safe, per
 * this file's own header, because neither parameter changes which row a
 * key addresses.
 */
export async function checkRateLimitBucket(
  pool: pg.Pool,
  scope: WebhookRateLimitScope,
  key: string,
  config: WebhookRateLimitConfig,
): Promise<RateLimitDecision> {
  const buckets = BUCKETS_BY_SCOPE[scope];
  const result = await pool.query(UPSERT_SQL, [scope, key, buckets, config.windowSeconds]);
  const row = result.rows[0] as { request_count: number; window_start: Date };
  const allowed = row.request_count <= config.limit;
  return {
    allowed,
    retryAfterSeconds: allowed ? 0 : computeRetryAfterSeconds(row.window_start, config.windowSeconds),
  };
}

/**
 * What the route actually calls: `scope`'s FIXED production budget from
 * `WEBHOOK_RATE_LIMITS`, never a caller-chosen one -- there is no parameter
 * through which route code could accidentally (or an attacker could ever)
 * supply a different limit/window than the one this module owns.
 */
export async function checkWebhookRateLimit(
  pool: pg.Pool,
  scope: WebhookRateLimitScope,
  key: string,
): Promise<RateLimitDecision> {
  return checkRateLimitBucket(pool, scope, key, WEBHOOK_RATE_LIMITS[scope]);
}

/**
 * Client IP for the invalid-signature `invalid_ip` scope -- the one budget
 * that must work even when the caller supplies no valid-looking workspace
 * id at all (hardening task 1's own framing: "an attacker who does not know
 * a valid workspace id still consumes resources"). Trusts
 * `x-forwarded-for`'s first (left-most, closest-to-client) entry, which is
 * what this deployment's reverse proxy is expected to set; a request with
 * no such header (no proxy in front, or a direct connection) falls back to
 * one shared "unknown" bucket rather than throwing or skipping the check.
 *
 * Known, stated limitation: `x-forwarded-for` is a plain request header,
 * so a deployment that does not have a trusted proxy stripping/overwriting
 * it would let an attacker forge a fresh value per request and defeat this
 * one scope specifically -- exactly why `invalid_workspace` and
 * `invalid_global` exist as independent, non-attacker-chosen scopes: an IP
 * spoofed per request still cannot escape either of those two.
 */
export function extractClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor !== null) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  return "unknown";
}
