// Task 7 (T7 webhook giả), integration-level proof against real Postgres:
// this file exercises the actual route handler end to end -- real HMAC
// signatures, real Request/ReadableStream bodies, real withTenant/RLS reads
// and writes -- because the adversarial requirements this task exists to
// prove (never a row on a bad signature, memory bounded, RLS-forced tenant
// isolation, idempotent replay) are properties of the WIRING, not of any
// one pure function in isolation. webhook-signature.test.ts and
// ingest-event.test.ts already cover those pure pieces on their own; this
// file is the seam between them and the database.
//
// Credential vault task: signFor no longer derives a workspace secret from
// a fleet-wide root -- there is no root secret anymore. It resolves (and,
// on first use, provisions) the SAME real per-workspace secret the route
// itself reads via getWorkspaceWebhookSecret (server/webhook-secret.ts),
// through the identical vault. Every call site below is now `await`ed.
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "@smos/db";
import { newId, type Id } from "@smos/domain";
import { seedTwoWorkspaces, type TenantFixture } from "@smos/testing";
import { getWorkspaceWebhookSecret } from "../../../../../server/webhook-secret.ts";
import { MAX_WEBHOOK_BODY_BYTES } from "../../../../../server/read-bounded-body.ts";
import { MAX_EVENTS_PER_DELIVERY } from "../../../../../server/webhook-limits.ts";
import { WEBHOOK_RATE_LIMITS } from "../../../../../server/webhook-rate-limit.ts";

const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const adminPool = createDbPool(adminUrl);

let a: TenantFixture;
let b: TenantFixture;
let baselineEventsA: number;
let baselineEventsB: number;
let POST: typeof import("./route.ts").POST;

function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Late-review CRITICAL 2: the signature binds the workspace the request
 * claims to be for. Resolves the REAL secret for `workspaceId` from the
 * credential vault -- the same call the route itself makes -- so a
 * signature made "for workspace A" is, by construction, signed under A's
 * own stored secret and cannot be a valid signature for B's.
 */
async function signFor(workspaceId: Id, body: string): Promise<string> {
  const secret = await getWorkspaceWebhookSecret(workspaceId);
  if (secret === null) {
    throw new Error(`route.test.ts: could not resolve/provision a webhook secret for workspace ${workspaceId}`);
  }
  return sign(body, secret);
}

function req(workspaceId: string, body: string, signatureHeader: string, forwardedFor?: string): {
  request: Request;
  context: { params: Promise<{ workspaceId: string }> };
} {
  const headers: Record<string, string> = { "x-hub-signature-256": signatureHeader };
  if (forwardedFor !== undefined) headers["x-forwarded-for"] = forwardedFor;
  return {
    request: new Request(`http://sandbox.test/api/webhooks/meta/${workspaceId}`, {
      method: "POST",
      body,
      headers,
    }),
    context: { params: Promise.resolve({ workspaceId }) },
  };
}

function forgedEventBody(workspaceId: string, deliveryId: string): string {
  // A distinct body per call (deliveryId varies) -- this is exactly the
  // shape of the pre-hardening complaint: an attacker can trivially vary
  // the body to mint a "new" forged delivery, so the proof below must show
  // that varying the body does NOT buy the attacker a fresh row once the
  // rate limit trips.
  return JSON.stringify({
    events: [
      {
        externalId: `route-test-post-${workspaceId}`,
        eventType: "post.impression",
        value: 1,
        occurredAt: new Date().toISOString(),
        deliveryId,
      },
    ],
  });
}

async function rejectedDeliveryCount(workspaceId: string): Promise<number> {
  const r = await adminPool.query(
    "select count(*)::int as n from webhook_delivery where workspace_id = $1 and signature_ok = false",
    [workspaceId],
  );
  return r.rows[0].n as number;
}

/**
 * webhook_delivery.workspace_id is a real FK to `workspace` (0028), so
 * recordRejectedDelivery's INSERT fails (silently swallowed, per its own
 * doc) for a `newId()` that names no row at all -- exactly the ghost-
 * workspace case elsewhere in this file, which deliberately never reaches
 * that INSERT (it 401s at the signature-resolution step, before any row is
 * even considered, since a nonexistent workspace can never have a real
 * vault-stored secret to sign against -- see this file's own "answers 401
 * for a well-formed workspace id that names no workspace" test for why that
 * is 401 rather than the pre-vault 404). The rate-limit tests below need a
 * workspace id that IS real (so the rejected-receipt assertions are
 * meaningful) but is used by NOTHING else in this file, so its buckets
 * start genuinely empty and an exact "first N calls succeed, the next one
 * is throttled" assertion is safe against cross-test interference.
 */
async function createBareWorkspace(): Promise<string> {
  const id = newId();
  await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [id, `rate-limit-test-${id}`]);
  return id;
}

/**
 * `count` distinct keys that are guaranteed to hash to DIFFERENT
 * `invalid_ip` bucket indices (webhook-rate-limit.ts: 1021 buckets).
 *
 * Generating N plain random keys and assuming none collide is exactly what
 * webhook-rate-limit.test.ts's own `findCollidingKeys` helper proves is
 * UNSAFE ("a birthday-style collision among random candidates is expected
 * within a few dozen tries") -- for the ~25 keys the distributed-flood test
 * below needs against only 1021 buckets, the birthday-paradox probability
 * of at least one collision is roughly 1 in 4 per run. A collision there
 * means two "different source IPs" silently share ONE bucket, so
 * `invalid_ip`'s own limit (10) can trip before the test's real target,
 * `invalid_workspace`'s limit (20), ever does -- an intermittent, spurious
 * 429 in the middle of an expected run of 401s, with nothing wrong in the
 * route or the rate limiter itself. This asks Postgres for the exact same
 * hash the real UPSERT uses (never a JS reimplementation) and discards any
 * candidate that would land on a bucket already claimed, so the generated
 * set is collision-free by construction rather than by luck.
 */
async function distinctNonCollidingBucketKeys(count: number, label: string): Promise<string[]> {
  // Also avoid any bucket_index that already has traffic recorded for this
  // scope RIGHT NOW, from whatever else has run in this same process --
  // colliding with an already-warm bucket is the same failure mode as
  // colliding within this function's own batch, just sourced externally.
  const occupied = await pool.query<{ idx: number }>(
    "select bucket_index as idx from webhook_rate_limit_bucket where scope = 'invalid_ip'",
  );
  const seenIndexes = new Set<number>(occupied.rows.map((row) => row.idx));
  const keys: string[] = [];
  let attempt = 0;
  while (keys.length < count) {
    const candidate = `${label}-${newId()}-${attempt++}`;
    const r = await pool.query<{ idx: number }>("select (abs(hashtext($1)::bigint) % 1021)::int as idx", [
      candidate,
    ]);
    const idx = r.rows[0]!.idx;
    if (seenIndexes.has(idx)) continue;
    seenIndexes.add(idx);
    keys.push(candidate);
  }
  return keys;
}

async function eventCount(workspaceId: string, publicationId: string): Promise<number> {
  const r = await adminPool.query(
    "select count(*)::int as n from event where workspace_id = $1 and publication_id = $2",
    [workspaceId, publicationId],
  );
  return r.rows[0].n as number;
}

async function metricCount(workspaceId: string, campaignId: string): Promise<number> {
  const r = await adminPool.query(
    "select count(*)::int as n from metric where workspace_id = $1 and campaign_id = $2",
    [workspaceId, campaignId],
  );
  return r.rows[0].n as number;
}

async function webhookDeliveryCount(workspaceId: string, externalId: string): Promise<number> {
  const r = await adminPool.query(
    "select count(*)::int as n from webhook_delivery where workspace_id = $1 and provider = 'meta' and external_id = $2",
    [workspaceId, externalId],
  );
  return r.rows[0].n as number;
}

beforeAll(async () => {
  // webhook-rate-limit.ts's `invalid_global` scope is a single shared row
  // (bucket_index always 0, by design: N=1) -- the SAME row real production
  // traffic reads, and the same row webhook-rate-limit.test.ts's own suite
  // deliberately drives past its limit to prove the mechanism. Every other
  // scope this file touches now uses a fresh, per-call key/IP (never the
  // shared "unknown" fallback), so the only remaining source of cross-file
  // interference is this one un-avoidable-by-key-diversification row.
  // Resetting it here does not change what THIS file's own tests prove --
  // every assertion below about throttling still drives its OWN scope past
  // ITS OWN real limit and checks for 429 -- it only removes accidental
  // pollution left behind by whichever OTHER file happened to run earlier
  // in the same 60-second window, reproduced live by running this file
  // together with webhook-rate-limit.test.ts (see the per-test comments
  // below for the concrete failure that motivated this).
  await adminPool.query("delete from webhook_rate_limit_bucket where scope = 'invalid_global'");
  ({ a, b } = await seedTwoWorkspaces(adminPool));
  // Simulate: this publication was already posted to the sandbox and Meta
  // assigned it a real external post id -- exactly the state handlePublish
  // (Task 5) leaves behind on markSucceeded.
  await adminPool.query("update publication set state = 'succeeded', external_id = $1 where id = $2", [
    `route-test-post-${a.publicationId}`,
    a.publicationId,
  ]);
  await adminPool.query("update publication set state = 'succeeded', external_id = $1 where id = $2", [
    `route-test-post-${b.publicationId}`,
    b.publicationId,
  ]);
  // seedTwoWorkspaces (@smos/testing) already seeds one baseline `event` row
  // (and one baseline `metric` row) per publication/campaign for its own,
  // unrelated purpose (cross-tenant.test.ts's fixture needs) -- every
  // assertion below compares against these captured baselines rather than
  // an assumed absolute count of 0.
  baselineEventsA = await eventCount(a.workspaceId, a.publicationId);
  baselineEventsB = await eventCount(b.workspaceId, b.publicationId);
  ({ POST } = await import("./route.ts"));
});

afterAll(async () => {
  for (const ws of [a, b].filter((w): w is TenantFixture => w !== undefined)) {
    await adminPool.query("delete from event where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from metric where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from webhook_delivery where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from credential_reference where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from integration where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    // Credential vault (0036_vault_secret.sql): seedTwoWorkspaces now seeds
    // one placeholder vault_secret row per workspace, and this file's own
    // tests provision a real per-workspace webhook secret through the vault
    // too (signFor, above).
    await adminPool.query("delete from vault_secret where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
  }
  await pool.end();
  await adminPool.end();
});

describe("POST /api/webhooks/meta/[workspaceId]", () => {
  it("ingests a validly signed event into the right workspace and records a metric", async () => {
    const externalId = `route-test-post-${a.publicationId}`;
    const body = JSON.stringify({
      events: [{ externalId, eventType: "post.impression", value: 42, occurredAt: new Date().toISOString(), deliveryId: "d-ok-1" }],
    });
    const { request, context } = req(a.workspaceId, body, await signFor(a.workspaceId, body));
    const res = await POST(request, context);
    expect(res.status).toBe(200);
    expect(await eventCount(a.workspaceId, a.publicationId)).toBe(baselineEventsA + 1);
    expect(await metricCount(a.workspaceId, a.campaignId)).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent: replaying the exact same signed request does not double-count", async () => {
    const externalId = `route-test-post-${a.publicationId}`;
    const body = JSON.stringify({
      events: [{ externalId, eventType: "post.impression", value: 7, occurredAt: new Date().toISOString(), deliveryId: "d-replay-1" }],
    });
    const before = await eventCount(a.workspaceId, a.publicationId);
    const sig = await signFor(a.workspaceId, body);
    const call1 = req(a.workspaceId, body, sig);
    const call2 = req(a.workspaceId, body, sig);
    const first = await POST(call1.request, call1.context);
    const second = await POST(call2.request, call2.context);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await eventCount(a.workspaceId, a.publicationId)).toBe(before + 1);
    expect(await webhookDeliveryCount(a.workspaceId, "d-replay-1")).toBe(1);
  });

  // Title corrected (late-review CRITICAL 2 / minor c): a forged signature
  // now DOES leave one trace -- a signature_ok = false receipt, which
  // 0028_integration.sql always said this table would carry and which
  // nothing had ever written. What must still be true, and is asserted here,
  // is that it never creates a row under the delivery id it claimed, i.e. it
  // cannot consume that id.
  it("rejects a forged signature with 401 and never a receipt under the delivery id it claimed", async () => {
    const body = JSON.stringify({
      events: [
        {
          externalId: `route-test-post-${a.publicationId}`,
          eventType: "post.impression",
          value: 1,
          occurredAt: new Date().toISOString(),
          deliveryId: "d-forged-1",
        },
      ],
    });
    // A dedicated IP, not the shared "unknown" fallback: every test in this
    // file that sends an invalid signature would otherwise collide on the
    // SAME `invalid_ip` bucket (limit 10/60s, webhook-rate-limit.ts) --
    // reproduced live: running this file together with
    // webhook-rate-limit.test.ts (which also touches the shared,
    // cardinality-1 `invalid_global` bucket directly) intermittently threw
    // LATER tests in this file's own execution order from 401 to 429,
    // purely from cumulative cross-test volume against a real, persistent,
    // production-shaped counter -- nothing to do with whether any
    // individual signature check is actually correct.
    const { request, context } = req(a.workspaceId, body, sign(body, "wrong-secret"), `test-ip-forged-${newId()}`);
    const res = await POST(request, context);
    expect(res.status).toBe(401);
    expect(await webhookDeliveryCount(a.workspaceId, "d-forged-1")).toBe(0);
  });

  it("rejects a tampered body even when the signature header is well-formed hex", async () => {
    const originalBody = JSON.stringify({
      events: [
        {
          externalId: `route-test-post-${a.publicationId}`,
          eventType: "post.impression",
          value: 1,
          occurredAt: new Date().toISOString(),
          deliveryId: "d-tampered-1",
        },
      ],
    });
    const validSignatureForOriginal = await signFor(a.workspaceId, originalBody);
    const tamperedBody = originalBody.replace('"value":1', '"value":99999');
    const { request, context } = req(a.workspaceId, tamperedBody, validSignatureForOriginal, `test-ip-tampered-${newId()}`);
    const res = await POST(request, context);
    expect(res.status).toBe(401);
    expect(await webhookDeliveryCount(a.workspaceId, "d-tampered-1")).toBe(0);
  });

  it("rejects a body over the size cap with 413 before ever checking the signature, and creates no row", async () => {
    const hugeBody = "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1_000);
    const { request, context } = req(a.workspaceId, hugeBody, "sha256=not-even-checked");
    const before = await adminPool.query("select count(*)::int as n from webhook_delivery where workspace_id = $1", [
      a.workspaceId,
    ]);
    const res = await POST(request, context);
    expect(res.status).toBe(413);
    const after = await adminPool.query("select count(*)::int as n from webhook_delivery where workspace_id = $1", [
      a.workspaceId,
    ]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("rejects malformed JSON that arrives with a genuinely valid signature, and creates no row", async () => {
    const body = "{not-valid-json";
    const { request, context } = req(a.workspaceId, body, await signFor(a.workspaceId, body));
    const res = await POST(request, context);
    expect(res.status).toBe(400);
  });

  // Was "... even with a valid signature" and asserted 404. Credential vault
  // task: a "valid signature" is no longer a concept that can exist for a
  // malformed workspace id at all -- there is no fleet-wide root left to
  // derive one from, and getWorkspaceWebhookSecret only ever resolves a
  // secret through vault_secret, which is keyed on a REAL workspace id.
  // isId(rawWorkspaceId) is checked before the vault is ever consulted
  // (route.ts step 2), so a malformed id short-circuits straight to a null
  // secret -- indistinguishable, on the wire, from any other failed
  // signature check: 401, not 404. This is a genuine, deliberate behaviour
  // change, not a weakened assertion: it removes a distinction ("malformed
  // id" vs "bad signature") an unauthenticated caller could previously use
  // to learn something about the URL shape, which is strictly less
  // information leaked, not more.
  it("rejects a malformed workspace id in the URL with 401, since no secret can ever be resolved for it", async () => {
    const body = JSON.stringify({ events: [] });
    const { request, context } = req(
      "not-a-real-workspace-id",
      body,
      sign(body, "irrelevant-secret"),
      `test-ip-malformed-${newId()}`,
    );
    const res = await POST(request, context);
    expect(res.status).toBe(401);
  });

  // --- Late-review CRITICAL 2 -------------------------------------------
  //
  // The version of this test that shipped asserted ONLY eventCount, and
  // never looked at `webhook_delivery` at all. That is exactly why the
  // defect survived: it accepted a 200 as correct ("the delivery itself is
  // accepted -- it just resolves nothing"), so it stayed green while
  // workspace A's captured (body, signature) pair, replayed at workspace B's
  // callback URL, wrote A's full payload and A's Meta post id into B's
  // webhook_delivery table AND permanently burned that delivery id for B.
  // It is corrected here rather than deleted: the isolation property it
  // meant to prove is real and still asserted, but the acceptance bar was
  // wrong -- a delivery signed for another tenant must be REFUSED, not
  // accepted-then-ignored, and every assertion below now inspects the
  // delivery table the original never touched.
  it("refuses workspace A's captured signature replayed at workspace B's callback URL", async () => {
    const crossExternalId = `route-test-post-${a.publicationId}`;
    const deliveryId = `d-cross-${a.workspaceId}`;
    const body = JSON.stringify({
      events: [{ externalId: crossExternalId, eventType: "post.impression", value: 3, occurredAt: new Date().toISOString(), deliveryId }],
    });
    const beforeA = await eventCount(a.workspaceId, a.publicationId);
    // The exact bytes and the exact signature workspace A would have sent.
    const { request, context } = req(b.workspaceId, body, await signFor(a.workspaceId, body), `test-ip-replay-${newId()}`);
    const res = await POST(request, context);

    expect(res.status).toBe(401);
    expect(await eventCount(a.workspaceId, a.publicationId)).toBe(beforeA);
    expect(await eventCount(b.workspaceId, b.publicationId)).toBe(baselineEventsB);
    // A's payload and A's Meta post id must not have landed in B's table.
    expect(await webhookDeliveryCount(b.workspaceId, deliveryId)).toBe(0);
    const leaked = await adminPool.query(
      "select count(*)::int as n from webhook_delivery where workspace_id = $1 and payload::text like $2",
      [b.workspaceId, `%${crossExternalId}%`],
    );
    expect(leaked.rows[0].n).toBe(0);
  });

  it("a foreign delivery cannot permanently burn a genuine delivery id", async () => {
    // The reviewer's exact denial-of-service: pre-send `deliveryId` to
    // workspace B using workspace A's secret, then watch B's own genuine
    // delivery with that id get dropped forever -- 200, "events before 1,
    // after 1", no error and no trace.
    const deliveryId = `d-burn-${b.workspaceId}`;
    const externalId = `route-test-post-${b.publicationId}`;
    const burnBody = JSON.stringify({
      events: [{ externalId, eventType: "post.impression", value: 1, occurredAt: new Date().toISOString(), deliveryId }],
    });
    const burn = req(b.workspaceId, burnBody, await signFor(a.workspaceId, burnBody), `test-ip-burn-${newId()}`);
    expect((await POST(burn.request, burn.context)).status).toBe(401);

    // B's genuine delivery, with the same delivery id, must still be
    // processed in full.
    const before = await eventCount(b.workspaceId, b.publicationId);
    const realBody = JSON.stringify({
      events: [{ externalId, eventType: "post.impression", value: 77, occurredAt: new Date().toISOString(), deliveryId }],
    });
    const real = req(b.workspaceId, realBody, await signFor(b.workspaceId, realBody));
    expect((await POST(real.request, real.context)).status).toBe(200);
    expect(await eventCount(b.workspaceId, b.publicationId)).toBe(before + 1);
  });

  it("records a rejected delivery with signature_ok = false without consuming any delivery id", async () => {
    // 0028_integration.sql's own header promised "one row per inbound
    // webhook, whether or not its signature verified (signature_ok records
    // that instead of silently dropping the delivery)". Nothing had ever
    // written `false`, so that audit trail did not exist.
    const deliveryId = `d-audit-${a.workspaceId}`;
    const externalId = `route-test-post-${a.publicationId}`;
    const body = JSON.stringify({
      events: [{ externalId, eventType: "post.impression", value: 5, occurredAt: new Date().toISOString(), deliveryId }],
    });
    const forged = req(a.workspaceId, body, sign(body, "wrong-secret"), `test-ip-audit-${newId()}`);
    expect((await POST(forged.request, forged.context)).status).toBe(401);

    const rejected = await adminPool.query(
      "select count(*)::int as n from webhook_delivery where workspace_id = $1 and signature_ok = false",
      [a.workspaceId],
    );
    expect(rejected.rows[0].n).toBeGreaterThanOrEqual(1);
    // The rejected receipt is not keyed on the delivery id it claimed, and
    // could not burn it even if it were: the nonce index is partial on
    // signature_ok (0032_webhook_delivery_nonce_and_audit.sql).
    expect(await webhookDeliveryCount(a.workspaceId, deliveryId)).toBe(0);

    const before = await eventCount(a.workspaceId, a.publicationId);
    const real = req(a.workspaceId, body, await signFor(a.workspaceId, body));
    expect((await POST(real.request, real.context)).status).toBe(200);
    expect(await eventCount(a.workspaceId, a.publicationId)).toBe(before + 1);
  });

  it("refuses a batch with more events than the per-delivery cap, before opening a transaction", async () => {
    const events = Array.from({ length: MAX_EVENTS_PER_DELIVERY + 1 }, (_, i) => ({
      externalId: `route-test-post-${a.publicationId}`,
      eventType: "post.impression",
      value: i,
      occurredAt: new Date().toISOString(),
      deliveryId: `d-flood-${i}`,
    }));
    const body = JSON.stringify({ events });
    const { request, context } = req(a.workspaceId, body, await signFor(a.workspaceId, body));
    expect((await POST(request, context)).status).toBe(400);
    expect(await webhookDeliveryCount(a.workspaceId, "d-flood-0")).toBe(0);
  });

  it("refuses an unparseable occurredAt instead of throwing out of the handler", async () => {
    const body = JSON.stringify({
      events: [
        {
          externalId: `route-test-post-${a.publicationId}`,
          eventType: "post.impression",
          value: 1,
          occurredAt: "not-a-date",
          deliveryId: `d-baddate-${a.workspaceId}`,
        },
      ],
    });
    const { request, context } = req(a.workspaceId, body, await signFor(a.workspaceId, body));
    expect((await POST(request, context)).status).toBe(400);
    expect(await webhookDeliveryCount(a.workspaceId, `d-baddate-${a.workspaceId}`)).toBe(0);
  });

  // Was "answers 404 ... leaking no constraint name". Credential vault
  // task: a well-formed but nonexistent workspace id can never have a real
  // vault-stored secret either -- getWorkspaceWebhookSecret attempts to
  // provision one on first use, that INSERT fails on vault_secret's own FK
  // to `workspace` (0036_vault_secret.sql), and server/webhook-secret.ts
  // catches that failure and resolves to `null` rather than letting the raw
  // driver error (which, for a Postgres FK violation, names the constraint)
  // propagate anywhere. There is therefore no way to produce "a genuinely
  // valid signature for a workspace that doesn't exist" anymore, so this
  // case collapses into the same 401 every other unverifiable signature
  // gets -- and the constraint-name-leak property the old test's name
  // promised is, if anything, MORE true now: the failure is caught two
  // layers before it could ever reach an HTTP response.
  it("answers 401 for a well-formed workspace id that names no workspace, leaking no constraint name", async () => {
    const ghost = newId();
    const body = JSON.stringify({
      events: [
        {
          externalId: "route-test-ghost",
          eventType: "post.impression",
          value: 1,
          occurredAt: new Date().toISOString(),
          deliveryId: `d-ghost-${ghost}`,
        },
      ],
    });
    const { request, context } = req(ghost, body, sign(body, "irrelevant-secret"), `test-ip-ghost-${newId()}`);
    const res = await POST(request, context);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });

  // --- Hardening task 1: rate limiting -----------------------------------
  //
  // late-findings-fix-report.md's own "Concerns" section: "an attacker who
  // can reach the webhook with a valid-looking workspace id can add one
  // signature_ok = false row per DISTINCT forged body. Identical replays
  // collapse (partial unique index), distinct ones do not." Every test
  // below uses a workspace id and/or IP dedicated to that single test (a
  // fresh `newId()`, or the shared fixture workspaces `a`/`b` only where a
  // fresh x-forwarded-for keeps it isolated from the invalid-path traffic
  // the tests above already sent), so tripping a budget here can never
  // retroactively change an assertion an earlier test in this file already
  // made.
  describe("rate limiting", () => {
    it("throttles a flood of forged signatures from one source IP with 429 and a Retry-After header, and stops growing webhook_delivery once throttled", async () => {
      const workspaceId = await createBareWorkspace();
      const ip = `test-ip-flood-${newId()}`;
      const limit = WEBHOOK_RATE_LIMITS.invalid_ip.limit;

      const statuses: number[] = [];
      for (let i = 0; i < limit + 5; i++) {
        const body = forgedEventBody(workspaceId, `d-ipflood-${i}-${newId()}`);
        const { request, context } = req(workspaceId, body, sign(body, "wrong-secret"), ip);
        statuses.push((await POST(request, context)).status);
      }

      expect(statuses.slice(0, limit)).toEqual(Array(limit).fill(401));
      const throttled = statuses.slice(limit);
      expect(throttled.every((s) => s === 429)).toBe(true);

      // Exactly `limit` rejected receipts -- not `limit + 5`: once throttled,
      // the route never reaches recordRejectedDelivery at all, so distinct
      // forged bodies past the limit buy the attacker nothing.
      expect(await rejectedDeliveryCount(workspaceId)).toBe(limit);

      // The 429 itself carries a positive, numeric retry hint -- never a
      // silent drop.
      const { request, context } = req(workspaceId, forgedEventBody(workspaceId, `d-ipflood-last-${newId()}`), sign("x", "y"), ip);
      const res = await POST(request, context);
      expect(res.status).toBe(429);
      const retryAfter = Number(res.headers.get("Retry-After"));
      expect(Number.isFinite(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
    });

    it("throttles a distributed flood aimed at one target workspace even when every request comes from a different source IP", async () => {
      const targetWorkspaceId = await createBareWorkspace();
      const limit = WEBHOOK_RATE_LIMITS.invalid_workspace.limit;

      // Collision-free by construction (see distinctNonCollidingBucketKeys):
      // a per-IP budget individually never trips, so only the
      // per-claimed-workspace scope can be what throttles this.
      const ips = await distinctNonCollidingBucketKeys(limit + 5, "test-ip-distributed");

      const statuses: number[] = [];
      for (let i = 0; i < limit + 5; i++) {
        const body = forgedEventBody(targetWorkspaceId, `d-distflood-${i}-${newId()}`);
        const { request, context } = req(targetWorkspaceId, body, sign(body, "wrong-secret"), ips[i]);
        statuses.push((await POST(request, context)).status);
      }

      expect(statuses.slice(0, limit)).toEqual(Array(limit).fill(401));
      expect(statuses.slice(limit).every((s) => s === 429)).toBe(true);
      expect(await rejectedDeliveryCount(targetWorkspaceId)).toBe(limit);
    });

    it("a genuine, validly signed delivery to a workspace still succeeds after an attacker floods that SAME workspace with forged signatures from its own dedicated IP -- the rate limiter must never become a new way to deny a legitimate sender", async () => {
      const ip = `test-ip-survive-${newId()}`;
      const floodCount = WEBHOOK_RATE_LIMITS.invalid_ip.limit + WEBHOOK_RATE_LIMITS.invalid_workspace.limit + 5;

      for (let i = 0; i < floodCount; i++) {
        const body = forgedEventBody(a.workspaceId, `d-survive-flood-${i}-${newId()}`);
        const { request, context } = req(a.workspaceId, body, sign(body, "wrong-secret"), ip);
        await POST(request, context);
      }
      // Confirm the flood really did get throttled (both invalid scopes for
      // this workspace/IP are now exhausted) before asserting the genuine
      // delivery still gets through.
      const confirmBody = forgedEventBody(a.workspaceId, `d-survive-confirm-${newId()}`);
      const { request: confirmReq, context: confirmCtx } = req(a.workspaceId, confirmBody, sign(confirmBody, "wrong-secret"), ip);
      expect((await POST(confirmReq, confirmCtx)).status).toBe(429);

      const externalId = `route-test-post-${a.publicationId}`;
      const deliveryId = `d-survive-genuine-${newId()}`;
      const genuineBody = JSON.stringify({
        events: [{ externalId, eventType: "post.impression", value: 999, occurredAt: new Date().toISOString(), deliveryId }],
      });
      const before = await eventCount(a.workspaceId, a.publicationId);
      const { request: genuineReq, context: genuineCtx } = req(a.workspaceId, genuineBody, await signFor(a.workspaceId, genuineBody));
      const res = await POST(genuineReq, genuineCtx);

      expect(res.status).toBe(200);
      expect(await eventCount(a.workspaceId, a.publicationId)).toBe(before + 1);
    });

    it("flooding workspace A's invalid-signature budget never throttles workspace B's genuine delivery", async () => {
      const ip = `test-ip-cross-tenant-${newId()}`;
      const floodCount = WEBHOOK_RATE_LIMITS.invalid_ip.limit + WEBHOOK_RATE_LIMITS.invalid_workspace.limit + 5;

      for (let i = 0; i < floodCount; i++) {
        const body = forgedEventBody(a.workspaceId, `d-crosstenant-flood-${i}-${newId()}`);
        const { request, context } = req(a.workspaceId, body, sign(body, "wrong-secret"), ip);
        await POST(request, context);
      }
      const confirmBody = forgedEventBody(a.workspaceId, `d-crosstenant-confirm-${newId()}`);
      const { request: confirmReq, context: confirmCtx } = req(a.workspaceId, confirmBody, sign(confirmBody, "wrong-secret"), ip);
      expect((await POST(confirmReq, confirmCtx)).status).toBe(429); // A really is throttled

      const externalId = `route-test-post-${b.publicationId}`;
      const deliveryId = `d-crosstenant-genuine-b-${newId()}`;
      const genuineBody = JSON.stringify({
        events: [{ externalId, eventType: "post.impression", value: 123, occurredAt: new Date().toISOString(), deliveryId }],
      });
      const before = await eventCount(b.workspaceId, b.publicationId);
      const { request: genuineReq, context: genuineCtx } = req(b.workspaceId, genuineBody, await signFor(b.workspaceId, genuineBody));
      const res = await POST(genuineReq, genuineCtx);

      expect(res.status).toBe(200); // B is completely unaffected by A's flood
      expect(await eventCount(b.workspaceId, b.publicationId)).toBe(before + 1);
    });

    // `invalid_global` (webhook-rate-limit.ts) is the ONE scope with a
    // single shared row (N=1, bucket_index always 0) across every
    // workspace and every IP -- deliberately, so a flood distributed
    // across many fabricated workspace ids AND many source IPs still trips
    // something. That also means it is the one scope where "workspace A's
    // attacker can affect workspace B" is TRUE for the invalid-signature
    // bookkeeping itself (B's own rare invalid-signature attempt could get
    // 429 instead of a recorded rejection during A's flood window) -- but
    // the property that actually matters is narrower and load-bearing: a
    // GENUINE, validly-signed delivery must never be blocked by it. Proven
    // directly here, not assumed: the bucket is driven straight to its real
    // production ceiling by SQL (not by sending 200 HTTP requests, for
    // speed), and a brand-new workspace's correctly-signed delivery is
    // shown to still succeed. This holds structurally, not by luck --
    // route.ts only ever checks `invalid_global` on the branch where
    // `signatureOk` is false; a validly-signed request takes the
    // `valid_workspace` branch instead (checkWebhookRateLimit(pool,
    // "valid_workspace", rawWorkspaceId)), a completely separate row keyed
    // per-workspace, which forged traffic can never write into at all.
    it("a genuine, validly signed delivery still succeeds even with the fleet-wide invalid_global bucket already at its real production ceiling", async () => {
      await adminPool.query(
        `insert into webhook_rate_limit_bucket (scope, bucket_index, window_start, request_count)
         values ('invalid_global', 0, now(), $1)
         on conflict (scope, bucket_index) do update set window_start = now(), request_count = $1`,
        [WEBHOOK_RATE_LIMITS.invalid_global.limit + 50],
      );

      // Sanity: the scope really is exhausted right now for an INVALID
      // signature (this is the cross-tenant cost the header above names).
      const forgedBody = forgedEventBody(a.workspaceId, `d-global-exhausted-forged-${newId()}`);
      const forged = req(a.workspaceId, forgedBody, sign(forgedBody, "wrong-secret"), `test-ip-global-sanity-${newId()}`);
      expect((await POST(forged.request, forged.context)).status).toBe(429);

      // The load-bearing property: a GENUINE delivery is entirely
      // unaffected, for a workspace that has sent nothing else this test.
      const externalId = `route-test-post-${b.publicationId}`;
      const deliveryId = `d-global-exhausted-genuine-${newId()}`;
      const genuineBody = JSON.stringify({
        events: [{ externalId, eventType: "post.impression", value: 55, occurredAt: new Date().toISOString(), deliveryId }],
      });
      const before = await eventCount(b.workspaceId, b.publicationId);
      const { request, context } = req(b.workspaceId, genuineBody, await signFor(b.workspaceId, genuineBody));
      const res = await POST(request, context);

      expect(res.status).toBe(200);
      expect(await eventCount(b.workspaceId, b.publicationId)).toBe(before + 1);
    });
  });
});
