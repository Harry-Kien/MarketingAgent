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
import { seedTwoWorkspaces, type TenantFixture } from "@smos/testing";
import { MAX_WEBHOOK_BODY_BYTES } from "../../../../../server/read-bounded-body.ts";

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
    const { request, context } = req(a.workspaceId, body, sign(body));
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
    const sig = sign(body);
    const call1 = req(a.workspaceId, body, sig);
    const call2 = req(a.workspaceId, body, sig);
    const first = await POST(call1.request, call1.context);
    const second = await POST(call2.request, call2.context);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await eventCount(a.workspaceId, a.publicationId)).toBe(before + 1);
    expect(await webhookDeliveryCount(a.workspaceId, "d-replay-1")).toBe(1);
  });

  it("rejects a forged signature with 401 and creates no row anywhere", async () => {
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
    const validSignatureForOriginal = sign(originalBody);
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
    const { request, context } = req(a.workspaceId, body, sign(body));
    const res = await POST(request, context);
    expect(res.status).toBe(400);
  });

  it("rejects a malformed workspace id in the URL even with a valid signature", async () => {
    const body = JSON.stringify({ events: [] });
    const { request, context } = req("not-a-real-workspace-id", body, sign(body));
    const res = await POST(request, context);
    expect(res.status).toBe(404);
  });

  it("never lets one workspace's webhook resolve another workspace's publication (RLS-forced isolation)", async () => {
    // A real, correctly-signed delivery arrives on workspace B's callback
    // URL but names workspace A's own external post id. Even though the
    // shared sandbox secret verifies it, workspace B's tenant scope must
    // not be able to see -- let alone attach an event to -- workspace A's
    // publication.
    const crossExternalId = `route-test-post-${a.publicationId}`;
    const body = JSON.stringify({
      events: [{ externalId: crossExternalId, eventType: "post.impression", value: 3, occurredAt: new Date().toISOString(), deliveryId: "d-cross-1" }],
    });
    const beforeA = await eventCount(a.workspaceId, a.publicationId);
    const { request, context } = req(b.workspaceId, body, sign(body));
    const res = await POST(request, context);
    expect(res.status).toBe(200); // the delivery itself is accepted (valid signature) -- it just resolves nothing
    expect(await eventCount(a.workspaceId, a.publicationId)).toBe(beforeA); // unchanged
    expect(await eventCount(b.workspaceId, b.publicationId)).toBe(baselineEventsB); // unchanged from baseline -- workspace B never had this publication either
  });
});
