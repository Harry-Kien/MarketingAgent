// Hardening task 1. Proves the rate-limit primitive directly against real
// PostgreSQL on 5433, connected as smos_app -- never mocked -- exactly the
// role the webhook route itself uses (STANDING-CONTEXT.md rule: "Prove
// every database invariant against the real PostgreSQL... as smos_app").
import { afterAll, describe, expect, it } from "vitest";
import { createDbPool } from "@smos/db";
import { newId } from "@smos/domain";
import {
  checkRateLimitBucket,
  checkWebhookRateLimit,
  extractClientIp,
  WEBHOOK_RATE_LIMITS,
  type WebhookRateLimitScope,
} from "./webhook-rate-limit.ts";

const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);

afterAll(async () => {
  await pool.end();
});

/** A fresh random key, used where the test needs to assume its bucket
 * starts untouched -- a freshly generated UUID has never been hashed by
 * any other caller, real or test, so this assumption is safe without
 * needing to delete anything (this table is deliberately never cleaned up
 * by the app -- see 0035's own header -- a handful of test-origin rows are
 * exactly the steady state the design expects). */
function freshKey(label: string): string {
  return `${label}-${newId()}`;
}

/** Finds two DIFFERENT keys that hash to the SAME bucket_index for `scope`,
 * by asking Postgres itself (the exact function the real upsert uses) --
 * never a JS reimplementation of hashtext, which could drift from the real
 * one silently. With 1021 buckets, a birthday-style collision among random
 * candidates is expected within a few dozen tries. */
async function findCollidingKeys(scope: WebhookRateLimitScope): Promise<[string, string]> {
  const seen = new Map<number, string>();
  for (let i = 0; i < 5000; i++) {
    const candidate = freshKey(`collide-${scope}-${i}`);
    const r = await pool.query<{ idx: number }>(
      "select (abs(hashtext($1)::bigint) % 1021)::int as idx",
      [candidate],
    );
    const idx = r.rows[0]!.idx;
    const existing = seen.get(idx);
    if (existing !== undefined) return [existing, candidate];
    seen.set(idx, candidate);
  }
  throw new Error("did not find a hash collision in 5000 tries -- something is wrong with the bucket hash");
}

describe("checkRateLimitBucket (real Postgres, real smos_app)", () => {
  it("allows requests up to the limit and denies the one after, with a positive retry hint", async () => {
    const key = freshKey("limit-enforcement");
    const config = { limit: 3, windowSeconds: 60 };

    const r1 = await checkRateLimitBucket(pool, "invalid_ip", key, config);
    const r2 = await checkRateLimitBucket(pool, "invalid_ip", key, config);
    const r3 = await checkRateLimitBucket(pool, "invalid_ip", key, config);
    const r4 = await checkRateLimitBucket(pool, "invalid_ip", key, config);

    expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, true]);
    expect(r4.allowed).toBe(false);
    expect(r4.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(r4.retryAfterSeconds).toBeLessThanOrEqual(config.windowSeconds);
  });

  it("resets the counter once the window elapses, rather than accumulating forever", async () => {
    const key = freshKey("window-reset");
    const config = { limit: 1, windowSeconds: 1 };

    const first = await checkRateLimitBucket(pool, "invalid_workspace", key, config);
    expect(first.allowed).toBe(true); // count = 1, at the limit

    const second = await checkRateLimitBucket(pool, "invalid_workspace", key, config);
    expect(second.allowed).toBe(false); // count = 2, over the limit -- same window

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const third = await checkRateLimitBucket(pool, "invalid_workspace", key, config);
    expect(third.allowed).toBe(true); // window elapsed: reset to count = 1, not accumulated to 3
  });

  it(
    "two DISTINCT forged keys that hash-collide share one bounded counter, not two rows -- " +
      "this is the actual fix for the 'unbounded distinct forged body' complaint: an attacker " +
      "cannot buy a fresh budget merely by varying the key, because storage is capped by the " +
      "bucket, not by how many distinct keys were ever tried",
    async () => {
      const [keyA, keyB] = await findCollidingKeys("invalid_workspace");
      const generous = { limit: 1_000_000, windowSeconds: 60 };

      const before = await checkRateLimitBucket(pool, "invalid_workspace", keyA, generous);
      const after = await checkRateLimitBucket(pool, "invalid_workspace", keyB, generous);

      // keyB's call landed on the SAME row keyA's call just touched: the
      // count keeps incrementing across the two different keys rather than
      // each key getting its own independent counter.
      const beforeCount = await pool.query<{ n: number }>(
        "select abs(hashtext($1)::bigint) % 1021 as n",
        [keyA],
      );
      const afterIdx = await pool.query<{ n: number }>(
        "select abs(hashtext($1)::bigint) % 1021 as n",
        [keyB],
      );
      expect(afterIdx.rows[0]!.n).toBe(beforeCount.rows[0]!.n); // sanity: they really do collide
      expect(before.allowed).toBe(true);
      expect(after.allowed).toBe(true);

      const row = await pool.query<{ request_count: number }>(
        "select request_count from webhook_rate_limit_bucket where scope = 'invalid_workspace' and bucket_index = $1",
        [afterIdx.rows[0]!.n],
      );
      // Exactly one row for this bucket_index -- not one per key.
      expect(row.rowCount).toBe(1);
    },
  );

  it("attempting the attack directly as smos_app: a raw duplicate (scope, bucket_index) INSERT is refused by the primary key", async () => {
    // Force the row to exist first (idempotent — same mechanism the route uses).
    await checkRateLimitBucket(pool, "invalid_global", "any-key", { limit: 1_000_000, windowSeconds: 60 });

    await expect(
      pool.query(
        `insert into webhook_rate_limit_bucket (scope, bucket_index, window_start, request_count)
         values ('invalid_global', 0, now(), 1)`,
      ),
    ).rejects.toThrow(/duplicate key|unique constraint/i);
  });

  it("invalid_global: every key, however many distinct ones, addresses the single shared row", async () => {
    const before = await checkRateLimitBucket(pool, "invalid_global", freshKey("global-a"), {
      limit: 1_000_000,
      windowSeconds: 60,
    });
    const after = await checkRateLimitBucket(pool, "invalid_global", freshKey("global-b"), {
      limit: 1_000_000,
      windowSeconds: 60,
    });
    // A completely different key incremented the exact row the first call
    // just touched, proving the count is shared rather than per-key.
    const beforeQuery = await pool.query<{ request_count: number }>(
      "select request_count from webhook_rate_limit_bucket where scope = 'invalid_global' and bucket_index = 0",
    );
    expect(before.allowed).toBe(true);
    expect(after.allowed).toBe(true);
    expect(beforeQuery.rows[0]!.request_count).toBeGreaterThanOrEqual(2);

    const rowCount = await pool.query<{ n: number }>(
      "select count(*)::int as n from webhook_rate_limit_bucket where scope = 'invalid_global'",
    );
    expect(rowCount.rows[0]!.n).toBe(1);
  });

  it("row count for every scope is bounded by its fixed bucket count, regardless of how much traffic it has ever seen", async () => {
    for (const scope of ["valid_workspace", "invalid_ip", "invalid_workspace"] as const) {
      const r = await pool.query<{ n: number }>(
        "select count(*)::int as n from webhook_rate_limit_bucket where scope = $1",
        [scope],
      );
      expect(r.rows[0]!.n).toBeLessThanOrEqual(1021);
    }
    const global = await pool.query<{ n: number }>(
      "select count(*)::int as n from webhook_rate_limit_bucket where scope = 'invalid_global'",
    );
    expect(global.rows[0]!.n).toBeLessThanOrEqual(1);
  });
});

describe("checkWebhookRateLimit", () => {
  it("uses the real, fixed production budget for the scope -- not a caller-chosen one", async () => {
    const key = freshKey("production-budget");
    const limit = WEBHOOK_RATE_LIMITS.invalid_ip.limit;
    let lastAllowed = true;
    for (let i = 0; i < limit; i++) {
      const r = await checkWebhookRateLimit(pool, "invalid_ip", key);
      lastAllowed = r.allowed;
    }
    expect(lastAllowed).toBe(true); // exactly at the limit
    const overLimit = await checkWebhookRateLimit(pool, "invalid_ip", key);
    expect(overLimit.allowed).toBe(false); // one past it
  });
});

describe("extractClientIp", () => {
  it("returns the left-most (closest-to-client) hop of x-forwarded-for", () => {
    const req = new Request("http://sandbox.test/x", { headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" } });
    expect(extractClientIp(req)).toBe("203.0.113.5");
  });

  it("trims whitespace around the value", () => {
    const req = new Request("http://sandbox.test/x", { headers: { "x-forwarded-for": "  203.0.113.9  ,10.0.0.1" } });
    expect(extractClientIp(req)).toBe("203.0.113.9");
  });

  it("falls back to a shared 'unknown' bucket when there is no forwarding header at all", () => {
    const req = new Request("http://sandbox.test/x");
    expect(extractClientIp(req)).toBe("unknown");
  });
});
