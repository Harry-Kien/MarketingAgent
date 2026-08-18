import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "@smos/db";
import { newId, type Id } from "@smos/domain";
import { getWorkspaceZaloWebhookSecret } from "../../../../../server/zalo-webhook-secret.ts";

const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);
let POST: typeof import("./route.ts").POST;
let workspaceId: Id;

function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function req(
  wsId: string,
  body: string,
  signatureHeader: string,
): { request: Request; context: { params: Promise<{ workspaceId: string }> } } {
  return {
    request: new Request(`http://sandbox.test/api/webhooks/zalo/${wsId}`, {
      method: "POST",
      body,
      headers: signatureHeader.length > 0 ? { "x-zalo-signature": signatureHeader } : {},
    }),
    context: { params: Promise.resolve({ workspaceId: wsId }) },
  };
}

function eventBody(msgId: string): string {
  return JSON.stringify({
    app_id: "test-app",
    event_name: "user_send_text",
    sender: { id: "user-1" },
    timestamp: String(Date.now()),
    message: { msg_id: msgId, text: "xin chao" },
  });
}

beforeAll(async () => {
  ({ POST } = await import("./route.ts"));
  workspaceId = newId();
  await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [workspaceId, `zalo-webhook-test-${workspaceId}`]);
});

afterAll(async () => {
  await adminPool.query(`delete from webhook_delivery where workspace_id = $1`, [workspaceId]);
  await adminPool.query(`delete from vault_secret where workspace_id = $1`, [workspaceId]);
  await adminPool.query(`delete from workspace where id = $1`, [workspaceId]);
  await adminPool.end();
});

describe("POST /api/webhooks/zalo/[workspaceId]", () => {
  it("refuses a request with no signature header at all", async () => {
    const { request, context } = req(workspaceId, eventBody(`msg-${newId()}`), "");
    expect((await POST(request, context)).status).toBe(401);
  });

  it("refuses an empty signature header", async () => {
    const { request, context } = req(workspaceId, eventBody(`msg-${newId()}`), "sha256=");
    expect((await POST(request, context)).status).toBe(401);
  });

  it("refuses a signature under the wrong algorithm prefix", async () => {
    const secret = await getWorkspaceZaloWebhookSecret(workspaceId);
    if (secret === null) throw new Error("could not provision a test secret");
    const body = eventBody(`msg-${newId()}`);
    const sha1Hex = createHmac("sha1", secret).update(body).digest("hex");
    const { request, context } = req(workspaceId, body, `sha1=${sha1Hex}`);
    expect((await POST(request, context)).status).toBe(401);
  });

  it("refuses a valid HMAC computed over different bytes than the ones actually received", async () => {
    const secret = await getWorkspaceZaloWebhookSecret(workspaceId);
    if (secret === null) throw new Error("could not provision a test secret");
    const signedBody = eventBody(`msg-signed-${newId()}`);
    const actualBody = eventBody(`msg-actual-${newId()}`);
    const { request, context } = req(workspaceId, actualBody, sign(signedBody, secret));
    expect((await POST(request, context)).status).toBe(401);
  });

  it("accepts a genuinely valid delivery, then a byte-for-byte replay of it is idempotent (still 200, not a second row)", async () => {
    const secret = await getWorkspaceZaloWebhookSecret(workspaceId);
    if (secret === null) throw new Error("could not provision a test secret");
    const msgId = `msg-replay-${newId()}`;
    const body = eventBody(msgId);
    const signature = sign(body, secret);

    const first = req(workspaceId, body, signature);
    expect((await POST(first.request, first.context)).status).toBe(200);

    const second = req(workspaceId, body, signature);
    expect((await POST(second.request, second.context)).status).toBe(200);

    const count = await adminPool.query(
      `select count(*)::int as n from webhook_delivery where workspace_id = $1 and provider = 'zalo' and external_id = $2 and signature_ok`,
      [workspaceId, msgId],
    );
    expect(count.rows[0].n).toBe(1);
  });
});
