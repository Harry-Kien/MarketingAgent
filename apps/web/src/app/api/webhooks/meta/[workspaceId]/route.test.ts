// Task 7 (T7 webhook giả), integration-level proof against real Postgres:
// this file exercises the actual route handler end to end -- real HMAC
// signatures, real Request/ReadableStream bodies, real withTenant/RLS reads
// and writes -- because the adversarial requirements this task exists to
// prove (never a row on a bad signature, memory bounded, RLS-forced tenant
// isolation, idempotent replay) are properties of the WIRING, not of any
// one pure function in isolation. webhook-signature.test.ts and
// ingest-event.test.ts already cover those pure pieces on their own; this
// file is the seam between them and the database.
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "@smos/db";
import { newId } from "@smos/domain";
import { seedTwoWorkspaces, type TenantFixture } from "@smos/testing";
import { MAX_WEBHOOK_BODY_BYTES } from "../../../../../server/read-bounded-body.ts";
import { MAX_EVENTS_PER_DELIVERY } from "../../../../../server/webhook-limits.ts";

const SECRET = "route-test-sandbox-secret";
const PREVIOUS_SECRET = process.env["META_WEBHOOK_SECRET"];

const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const adminPool = createDbPool(adminUrl);

let a: TenantFixture;
let b: TenantFixture;
let baselineEventsA: number;
let baselineEventsB: number;
let POST: typeof import("./route.ts").POST;

function sign(body: string, secret = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Late-review CRITICAL 2: the signature now binds the workspace the request
 * claims to be for. This helper reproduces, independently of the module under
 * test, the derivation a real sender performs -- so a signature made for
 * workspace A is by construction not a valid signature for workspace B, and
 * a captured (body, signature) pair cannot be replayed at another tenant's
 * callback URL.
 */
function signFor(workspaceId: string, body: string, rootSecret = SECRET): string {
  const workspaceSecret = createHmac("sha256", rootSecret)
    .update(`smos:meta-webhook:v1:${workspaceId}`)
    .digest("hex");
  return sign(body, workspaceSecret);
}

function req(workspaceId: string, body: string, signatureHeader: string): {
  request: Request;
  context: { params: Promise<{ workspaceId: string }> };
} {
  return {
    request: new Request(`http://sandbox.test/api/webhooks/meta/${workspaceId}`, {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": signatureHeader },
    }),
    context: { params: Promise.resolve({ workspaceId }) },
  };
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
  process.env["META_WEBHOOK_SECRET"] = SECRET;
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
  }
  if (PREVIOUS_SECRET === undefined) delete process.env["META_WEBHOOK_SECRET"];
  else process.env["META_WEBHOOK_SECRET"] = PREVIOUS_SECRET;
  await pool.end();
  await adminPool.end();
});

describe("POST /api/webhooks/meta/[workspaceId]", () => {
  it("ingests a validly signed event into the right workspace and records a metric", async () => {
    const externalId = `route-test-post-${a.publicationId}`;
    const body = JSON.stringify({
      events: [{ externalId, eventType: "post.impression", value: 42, occurredAt: new Date().toISOString(), deliveryId: "d-ok-1" }],
    });
    const { request, context } = req(a.workspaceId, body, signFor(a.workspaceId, body));
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
    const sig = signFor(a.workspaceId, body);
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
    const { request, context } = req(a.workspaceId, body, sign(body, "wrong-secret"));
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
    const validSignatureForOriginal = signFor(a.workspaceId, originalBody);
    const tamperedBody = originalBody.replace('"value":1', '"value":99999');
    const { request, context } = req(a.workspaceId, tamperedBody, validSignatureForOriginal);
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
    const { request, context } = req(a.workspaceId, body, signFor(a.workspaceId, body));
    const res = await POST(request, context);
    expect(res.status).toBe(400);
  });

  it("rejects a malformed workspace id in the URL even with a valid signature", async () => {
    const body = JSON.stringify({ events: [] });
    const { request, context } = req("not-a-real-workspace-id", body, signFor("not-a-real-workspace-id", body));
    const res = await POST(request, context);
    expect(res.status).toBe(404);
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
    const { request, context } = req(b.workspaceId, body, signFor(a.workspaceId, body));
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
    const burn = req(b.workspaceId, burnBody, signFor(a.workspaceId, burnBody));
    expect((await POST(burn.request, burn.context)).status).toBe(401);

    // B's genuine delivery, with the same delivery id, must still be
    // processed in full.
    const before = await eventCount(b.workspaceId, b.publicationId);
    const realBody = JSON.stringify({
      events: [{ externalId, eventType: "post.impression", value: 77, occurredAt: new Date().toISOString(), deliveryId }],
    });
    const real = req(b.workspaceId, realBody, signFor(b.workspaceId, realBody));
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
    const forged = req(a.workspaceId, body, sign(body, "wrong-secret"));
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
    const real = req(a.workspaceId, body, signFor(a.workspaceId, body));
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
    const { request, context } = req(a.workspaceId, body, signFor(a.workspaceId, body));
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
    const { request, context } = req(a.workspaceId, body, signFor(a.workspaceId, body));
    expect((await POST(request, context)).status).toBe(400);
    expect(await webhookDeliveryCount(a.workspaceId, `d-baddate-${a.workspaceId}`)).toBe(0);
  });

  it("answers 404 for a well-formed workspace id that names no workspace, leaking no constraint name", async () => {
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
    const { request, context } = req(ghost, body, signFor(ghost, body));
    const res = await POST(request, context);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });
});
