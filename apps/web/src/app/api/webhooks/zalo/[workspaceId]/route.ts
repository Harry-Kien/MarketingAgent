import { createHash } from "node:crypto";
import { isId, newId, type Id } from "@smos/domain";
import { withTenant } from "@smos/db";
import { logger } from "@smos/telemetry";
import { getPool } from "../../../../../server/db.ts";
import { verifySignature } from "../../../../../server/webhook-signature.ts";
import { getWorkspaceZaloWebhookSecret } from "../../../../../server/zalo-webhook-secret.ts";
import { checkWebhookRateLimit, extractClientIp } from "../../../../../server/webhook-rate-limit.ts";
import { BodyTooLargeError, MAX_WEBHOOK_BODY_BYTES, readBoundedBody } from "../../../../../server/read-bounded-body.ts";

// Every request does real I/O (DB); nothing about this route can be
// statically cached or prerendered.
export const dynamic = "force-dynamic";

const SIGNATURE_HEADER = "x-zalo-signature";
const PROVIDER = "zalo";

/**
 * M2B Task 4. Follows apps/web/src/app/api/webhooks/meta/[workspaceId]/
 * route.ts's own ordering exactly: bounded read -> signature verify (over
 * the per-workspace secret, so the workspace a delivery claims to be for is
 * itself covered by the signature) -> rate limit -> only then parse the
 * body -> record the delivery under the nonce-shaped UNIQUE (workspace_id,
 * provider, external_id) WHERE signature_ok index (0032_webhook_delivery_
 * nonce_and_audit.sql), so a captured signature cannot be replayed for a
 * second effect.
 *
 * Deliberately narrower than the Meta route in one respect: this route
 * does not yet write into customer_contact/conversation/message. Wiring a
 * verified inbound Zalo event into the conversation domain is the
 * advisory agent's own dispatch path (M2C, which depends on this plan) --
 * this route's job is limited to proving the delivery is genuine and
 * recording it exactly once, which is a complete, independently testable
 * property on its own.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId: rawWorkspaceId } = await context.params;

  let rawBody: string;
  try {
    rawBody = await readBoundedBody(request.body, MAX_WEBHOOK_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      logger.warn("zalo webhook body exceeded the cap; refused before parsing", { workspaceId: rawWorkspaceId });
      return new Response(null, { status: 413 });
    }
    throw error;
  }

  const signatureHeader = request.headers.get(SIGNATURE_HEADER) ?? "";
  const workspaceSecret = isId(rawWorkspaceId) ? await getWorkspaceZaloWebhookSecret(rawWorkspaceId as Id) : null;
  const signatureOk = workspaceSecret !== null && verifySignature(rawBody, signatureHeader, workspaceSecret);
  const pool = getPool();

  let throttledRetryAfterSeconds: number | null = null;
  if (signatureOk) {
    const decision = await checkWebhookRateLimit(pool, "valid_workspace", rawWorkspaceId);
    if (!decision.allowed) throttledRetryAfterSeconds = decision.retryAfterSeconds;
  } else {
    const ipDecision = await checkWebhookRateLimit(pool, "invalid_ip", extractClientIp(request));
    const workspaceDecision = isId(rawWorkspaceId)
      ? await checkWebhookRateLimit(pool, "invalid_workspace", rawWorkspaceId)
      : null;
    const globalDecision = await checkWebhookRateLimit(pool, "invalid_global", "global");
    const blocked = [ipDecision, workspaceDecision, globalDecision].find(
      (decision): decision is NonNullable<typeof decision> => decision !== null && !decision.allowed,
    );
    if (blocked) throttledRetryAfterSeconds = blocked.retryAfterSeconds;
  }
  if (throttledRetryAfterSeconds !== null) {
    logger.warn("zalo webhook rate limit exceeded; throttling before any delivery row is written", {
      workspaceId: rawWorkspaceId,
      signatureOk,
    });
    return new Response(null, { status: 429, headers: { "Retry-After": String(throttledRetryAfterSeconds) } });
  }

  if (!signatureOk) {
    const bodyDigest = createHash("sha256").update(rawBody).digest("hex");
    logger.warn("zalo webhook signature verification failed", {
      workspaceId: rawWorkspaceId,
      bodyDigest: bodyDigest.slice(0, 16),
      hadSignatureHeader: signatureHeader.length > 0,
    });
    await recordRejectedDelivery(rawWorkspaceId, bodyDigest);
    return new Response(null, { status: 401 });
  }

  if (!isId(rawWorkspaceId)) {
    return new Response(null, { status: 404 });
  }
  const workspaceId = rawWorkspaceId as Id;

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!isValidZaloWebhookBody(parsedBody)) {
    return new Response(null, { status: 400 });
  }

  const exists = await withTenant(pool, workspaceId, (tx) =>
    tx.query(`select 1 from workspace where id = $1`, [workspaceId]));
  if (exists.rowCount === 0) {
    return new Response(null, { status: 404 });
  }

  const deliveryId = parsedBody.message?.msg_id ?? `${parsedBody.event_name}:${parsedBody.timestamp}`;
  await withTenant(pool, workspaceId, (tx) =>
    tx.query(
      `insert into webhook_delivery (id, workspace_id, provider, external_id, signature_ok, payload)
       values ($1, $2, $3, $4, true, $5::jsonb)
       on conflict (workspace_id, provider, external_id) where signature_ok do nothing`,
      [newId(), workspaceId, PROVIDER, deliveryId, JSON.stringify(parsedBody)],
    ));

  return new Response(null, { status: 200 });
}

async function recordRejectedDelivery(rawWorkspaceId: string, bodyDigest: string): Promise<void> {
  if (!isId(rawWorkspaceId)) return;
  const workspaceId = rawWorkspaceId as Id;
  try {
    await withTenant(getPool(), workspaceId, (tx) =>
      tx.query(
        `insert into webhook_delivery (id, workspace_id, provider, external_id, signature_ok, payload)
         values ($1, $2, $3, $4, false, '{}'::jsonb)
         on conflict (workspace_id, provider, external_id) where not signature_ok do nothing`,
        [newId(), workspaceId, PROVIDER, `rejected:${bodyDigest.slice(0, 32)}`],
      ));
  } catch (error) {
    logger.warn("could not record a rejected zalo webhook delivery receipt", {
      workspaceId: rawWorkspaceId,
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
}

interface ZaloWebhookBody {
  app_id: string;
  event_name: string;
  sender: { id: string };
  timestamp: string;
  message?: { msg_id: string; text?: string };
}

function isValidZaloWebhookBody(value: unknown): value is ZaloWebhookBody {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["app_id"] !== "string" || v["app_id"].length === 0) return false;
  if (typeof v["event_name"] !== "string" || v["event_name"].length === 0) return false;
  if (typeof v["timestamp"] !== "string" || v["timestamp"].length === 0) return false;
  const sender = v["sender"];
  if (typeof sender !== "object" || sender === null || typeof (sender as Record<string, unknown>)["id"] !== "string") return false;
  const message = v["message"];
  if (message !== undefined) {
    if (typeof message !== "object" || message === null) return false;
    if (typeof (message as Record<string, unknown>)["msg_id"] !== "string") return false;
  }
  return true;
}
