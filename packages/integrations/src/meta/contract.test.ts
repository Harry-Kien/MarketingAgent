import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeMetaServer, type FakeMetaServer } from "./fake-server.ts";
import { createMetaAdapter } from "./client.ts";
import { AdapterError } from "../errors.ts";
import type { FetchLike } from "../guarded-fetch.ts";

// Deviation from the plan's literal example, disclosed up front (see report):
//
// The plan's own contract test used `baseUrl: server.url` with `server.url`
// implied to be a real `http://127.0.0.1:<port>` (it says the fake server
// "dùng node:http") and `allowedHosts: ["127.0.0.1"]`. Both of those are
// incompatible with the egress guard as actually built and approved in
// Tasks 1-2: `assertEgressAllowed` requires `https:` unconditionally, and
// `assertResolvedAddressAllowed` blocks the entire 127.0.0.0/8 loopback
// range unconditionally -- BEFORE it even looks at `allowedHosts`. A real
// server bound to 127.0.0.1, reached through the (correctly) unweakened
// guard, cannot ever pass, on any protocol. Standing constraint #1 ("no
// real outbound network request, ever") plus the requirement that this
// adapter route every call through `guardedFetch` (not bare `fetch`) means
// the fake server here is genuinely in-process, exactly as the task brief
// explicitly allows ("a local in-process or localhost fake"): `fetchImpl`
// never opens a socket, so `startFakeMetaServer()` returns an injectable
// `FetchLike` alongside a synthetic, domain-name-shaped `url`
// (`https://sandbox.meta.test`) that is never actually dialed. Because it
// is a domain name (not an IP literal, not "localhost"), it passes
// `assertResolvedAddressAllowed`'s intentional pass-through for unresolved
// domain names -- the same path a real `graph.facebook.com` call would
// take -- while `allowedHosts` and the https-only check are still
// genuinely exercised. `createMetaAdapter` takes `fetchImpl` as an
// additive second, optional parameter (defaults to the real global
// `fetch`, unchanged for real Meta calls) purely to wire the fake in --
// exactly the same injection point `guardedFetch` itself already exposed
// for this reason.
let server: FakeMetaServer;

beforeAll(async () => {
  server = await startFakeMetaServer();
});
afterAll(async () => {
  await server.close();
});

function adapterFor(overrides: Partial<Parameters<typeof createMetaAdapter>[0]> = {}, fetchImpl: FetchLike = server.fetchImpl) {
  return createMetaAdapter(
    { baseUrl: server.url, pageId: "page-1", token: "sandbox-token", allowedHosts: ["sandbox.meta.test"], ...overrides },
    fetchImpl,
  );
}

const input = (key: string, content = "Bai dang that", targetAccountId = "page-1") => ({
  idempotencyKey: key,
  publicationContent: content,
  contentHash: "hash-" + content,
  targetAccountId,
});

describe("meta adapter contract", () => {
  it("publishes and returns an external id and permalink", async () => {
    const adapter = adapterFor();
    const r = await adapter.publish(input("k1"));
    expect(r.externalId).toMatch(/^page-1_/);
    expect(r.permalink).toContain(r.externalId);
    expect(r.evidence).toHaveProperty("requestId");
  });

  it("is idempotent: the same key returns the same post, not a second one", async () => {
    const adapter = adapterFor();
    const a = await adapter.publish(input("k2"));
    const b = await adapter.publish(input("k2"));
    expect(b.externalId).toBe(a.externalId);
    expect([...server.posts.keys()].filter((k) => k === a.externalId)).toHaveLength(1);
  });

  it("rejects blank content with invalid_input, not a fake success", async () => {
    const adapter = adapterFor();
    await expect(adapter.publish(input("k3", "   "))).rejects.toMatchObject({ kind: "invalid_input", retryable: false });
  });

  it("surfaces rate limiting as retryable with retryAfterMs", async () => {
    const adapter = adapterFor();
    await expect(adapter.publish(input("k4", "content", "page-rate-limited")))
      .rejects.toMatchObject({ kind: "rate_limited", retryable: true, retryAfterMs: 5000 });
  });

  it("surfaces an expired token as auth_expired and non-retryable", async () => {
    const bad = adapterFor({ token: "expired" });
    await expect(bad.publish(input("k5"))).rejects.toMatchObject({ kind: "auth_expired", retryable: false });
  });

  it("surfaces a distinctly invalid (not merely expired) token as auth_expired and non-retryable too", async () => {
    // Real Meta behaviour: an unrecognised/malformed token and an expired
    // session both come back as OAuthException code 190 -- the taxonomy
    // has no separate "invalid token" kind, so both must land on
    // auth_expired, not slip through as a successful call.
    const bad = adapterFor({ token: "invalid" });
    await expect(bad.publish(input("k5b"))).rejects.toMatchObject({ kind: "auth_expired", retryable: false });
  });

  it("never leaks the token in the error message", async () => {
    // Was vacuous: `input("k6")` targets the default "page-1" account with
    // non-blank content and a token that is neither "expired" nor
    // "invalid", so `publish` always resolved and the `catch` body -- the
    // test's only assertion -- never ran. `.catch((e) => e)` (rather than
    // try/catch) makes that failure mode structurally impossible: if
    // `publish` resolves, `err` is a `PublishResult`, not an `AdapterError`,
    // and `toBeInstanceOf` below fails loudly instead of silently skipping.
    // `page-rate-limited` echoes the presented token into its error message
    // (see fake-server.ts), so this exercises a real leak-then-redact path.
    const secretToken = "EAAsupersecret";
    const bad = adapterFor({ token: secretToken });
    const err: unknown = await bad.publish(input("k6", "content", "page-rate-limited")).catch((e) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).message).toContain(secretToken);
    expect((err as AdapterError).safeMessage).not.toContain(secretToken);
  });

  it("health check reports true for a reachable sandbox", async () => {
    const adapter = adapterFor();
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });
});

describe("meta adapter -- full Graph error-response taxonomy (beyond the plan's base 7)", () => {
  it("surfaces a permission/quota rejection (403) as quota_exceeded, non-retryable", async () => {
    const adapter = adapterFor();
    await expect(adapter.publish(input("q1", "content", "page-quota-exceeded")))
      .rejects.toMatchObject({ kind: "quota_exceeded", retryable: false });
  });

  it("surfaces a transient 5xx as upstream_unavailable, retryable", async () => {
    const adapter = adapterFor();
    await expect(adapter.publish(input("q2", "content", "page-upstream-down")))
      .rejects.toMatchObject({ kind: "upstream_unavailable", retryable: true });
  });

  it("surfaces a malformed / non-JSON response body as upstream_unavailable, retryable -- not a silent fake success", async () => {
    const adapter = adapterFor();
    await expect(adapter.publish(input("q3", "content", "page-malformed")))
      .rejects.toMatchObject({ kind: "upstream_unavailable", retryable: true });
  });

  it("surfaces a request that times out as upstream_unavailable, retryable, without waiting for the slow response", async () => {
    // The fake server's "page-slow" branch deliberately delays 200ms before
    // answering. A 20ms adapter timeout must win the race -- proving this
    // is a real timeout, not an accidental fast pass.
    const adapter = adapterFor({ timeoutMs: 20 });
    const started = Date.now();
    await expect(adapter.publish(input("q4", "content", "page-slow")))
      .rejects.toMatchObject({ kind: "upstream_unavailable", retryable: true });
    expect(Date.now() - started).toBeLessThan(150);
  });

  it("surfaces a catch-all non-2xx (404) as permanent_rejection, non-retryable", async () => {
    const adapter = adapterFor();
    await expect(adapter.publish(input("q5", "content", "page-not-found")))
      .rejects.toMatchObject({ kind: "permanent_rejection", retryable: false });
  });
});

describe("meta adapter -- adversarial self-review", () => {
  it("refuses to follow a redirect to a blocked, internal-looking address -- never calls fetchImpl a second time", async () => {
    let calls = 0;
    const counting: FetchLike = (input, init) => {
      calls++;
      return server.fetchImpl(input, init);
    };
    const adapter = adapterFor({}, counting);
    await expect(adapter.publish(input("r1", "content", "page-redirect-trap"))).rejects.toThrow(/blocked|internal|allowlist/i);
    // Exactly one call: the initial request that returned the 302. The
    // guard must refuse the Location header BEFORE a second fetchImpl call
    // is ever made -- proving guardedFetch's per-hop re-check is really
    // wired in, not bypassed.
    expect(calls).toBe(1);
  });

  it("refuses to contact a host that is not on the allowlist -- zero fetchImpl calls made", async () => {
    let calls = 0;
    const counting: FetchLike = (input, init) => {
      calls++;
      return server.fetchImpl(input, init);
    };
    const adapter = adapterFor({ allowedHosts: ["someone-else.test"] }, counting);
    await expect(adapter.publish(input("r2"))).rejects.toThrow(/allowlist/i);
    expect(calls).toBe(0);
  });

  it("refuses a downgraded http:// baseUrl -- zero fetchImpl calls made", async () => {
    let calls = 0;
    const counting: FetchLike = (input, init) => {
      calls++;
      return server.fetchImpl(input, init);
    };
    const adapter = adapterFor({ baseUrl: "http://sandbox.meta.test" }, counting);
    await expect(adapter.publish(input("r3"))).rejects.toThrow(/https/i);
    expect(calls).toBe(0);
  });

  it("never retries on its own, even for a retryable-kind failure -- exactly one fetchImpl call per publish() call", async () => {
    let calls = 0;
    const counting: FetchLike = (input, init) => {
      calls++;
      return server.fetchImpl(input, init);
    };
    const adapter = adapterFor({}, counting);
    await expect(adapter.publish(input("r4", "content", "page-rate-limited"))).rejects.toMatchObject({ kind: "rate_limited" });
    expect(calls).toBe(1);
  });

  it("never leaks a secret-shaped token even when the sandbox itself echoes it back into an error body", async () => {
    // Realistic case (documented in errors.ts): Meta's real Graph API
    // sometimes echoes the presented token back into an error message.
    // page-rate-limited always 429s regardless of token, so this is a
    // deterministic way to force an error path with a secret-shaped token
    // and confirm the raw message actually contained it (proving the
    // redaction did real work, not that there was nothing to redact).
    const secretToken = "EAAsupersecretvalue1234567890abcdefghij";
    const bad = adapterFor({ token: secretToken });
    try {
      await bad.publish(input("r5", "content", "page-rate-limited"));
      expect.unreachable("expected page-rate-limited to always reject");
    } catch (e) {
      const err = e as AdapterError;
      expect(err.message).toContain(secretToken);
      expect(err.safeMessage).not.toContain(secretToken);
    }
  });

  it("never puts a secret-shaped token in a successful publish's evidence", async () => {
    const secretToken = "EAAsupersecretvalue1234567890abcdefghij";
    const adapter = adapterFor({ token: secretToken });
    const r = await adapter.publish(input("r6"));
    expect(JSON.stringify(r.evidence)).not.toContain(secretToken);
  });

  it("does not manufacture a NaN retryAfterMs from a malformed Retry-After header", async () => {
    // page-rate-limited-bad-header sends a non-numeric Retry-After. A
    // downstream retry scheduler (Task 5, out of scope here) could treat a
    // NaN backoff as "retry immediately forever" -- worse than no hint at
    // all -- so retryAfterMs must be omitted rather than set to NaN.
    const adapter = adapterFor();
    const err: unknown = await adapter.publish(input("r7", "content", "page-rate-limited-bad-header")).catch((e) => e);
    expect(err).toMatchObject({ kind: "rate_limited", retryable: true });
    expect((err as AdapterError).retryAfterMs).toBeUndefined();
  });
});
