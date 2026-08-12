import { createHash } from "node:crypto";
import { isId, newId, type Id } from "@smos/domain";
import { createDbPool, withTenant, type TenantTx } from "@smos/db";
import { handleIngestEvent, type IngestEventDeps, type IngestEventPayload } from "@smos/worker";
import { logger } from "@smos/telemetry";
import { verifySignature } from "../../../../../server/webhook-signature.ts";
import { BodyTooLargeError, MAX_WEBHOOK_BODY_BYTES, readBoundedBody } from "../../../../../server/read-bounded-body.ts";

// Every request does real I/O (DB); nothing about this route can be
// statically cached or prerendered.
export const dynamic = "force-dynamic";

const SIGNATURE_HEADER = "x-hub-signature-256";
const PROVIDER = "meta";

/**
 * Task 7 (T7 webhook giả): this route is the one place external, untrusted
 * bytes enter the system, so every step below is ordered deliberately --
 * see each comment for exactly which hostile-input requirement it closes.
 *
 * The callback URL is workspace-scoped (`/api/webhooks/meta/<workspaceId>`)
 * rather than one single global endpoint. This is a deliberate, disclosed
 * simplification: Meta's real webhook architecture signs every delivery
 * with one app-level secret and expects the receiver to fan a single
 * callback URL out to the right tenant by looking up the page/account id
 * inside the (now-trusted, post-verification) payload -- which requires a
 * lookup table that can answer "which workspace owns this external account
 * id" WITHOUT already knowing the workspace, i.e. a query that cannot be
 * scoped through `withTenant`/RLS the way every other read in this
 * application is (RLS-scoped tables return zero rows when
 * `app.workspace_id` is unset, by design). Building that lookup table is
 * real M2 OAuth-lifecycle infrastructure (Non-Goals) and no vault/secret
 * resolution exists yet to obtain a real per-tenant secret from
 * `credential_reference.vault_key` (which is deliberately only an opaque
 * pointer, never a real value -- Task 3). A workspace-scoped URL sidesteps
 * that unsolved problem entirely while still proving every real invariant
 * this task cares about: signature verification, replay defense, bounded
 * memory, and RLS-forced tenant isolation on every write.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId: rawWorkspaceId } = await context.params;

  // 1) Bounded read, before the body is handed to anything else. A body
  // that exceeds the cap is refused outright -- never buffered in full,
  // never signature-checked, never parsed (T7: "confirm a large body
  // cannot exhaust memory").
  let rawBody: string;
  try {
    rawBody = await readBoundedBody(request.body, MAX_WEBHOOK_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      logger.warn("webhook body exceeded the cap; refused before parsing", {
        workspaceId: rawWorkspaceId,
      });
      return new Response(null, { status: 413 });
    }
    throw error;
  }

  // 2) Verify the signature over the exact raw bytes received, before
  // anything else looks at the body's content or the caller-supplied
  // workspace id is trusted for anything beyond routing. A missing secret
  // (misconfigured server) fails exactly like a bad signature -- never
  // treated as "skip verification".
  const signatureHeader = request.headers.get(SIGNATURE_HEADER) ?? "";
  const secret = getWebhookSecret();
  if (secret === null || !verifySignature(rawBody, signatureHeader, secret)) {
    // Never the raw body, never the signature value, never a database row
    // -- only a fixed-size digest, so a forged giant or secret-shaped
    // payload never leaves a trace bigger than one fingerprint (T7: "never
    // logged in full", "never creates a row").
    logger.warn("webhook signature verification failed", {
      workspaceId: rawWorkspaceId,
      bodyDigest: createHash("sha256").update(rawBody).digest("hex").slice(0, 16),
      hadSignatureHeader: signatureHeader.length > 0,
    });
    return new Response(null, { status: 401 });
  }

  // 3) Only a signature-verified request's workspace id is trusted enough
  // to route with. isId is a pure shape check (well-formed UUIDv7), not an
  // existence check -- an id that merely LOOKS valid but names no real
  // workspace fails later at the FK on webhook_delivery.workspace_id, and
  // at RLS (which returns zero rows for a workspace_id nothing was ever
  // scoped to), never silently.
  if (!isId(rawWorkspaceId)) {
    return new Response(null, { status: 404 });
  }
  const workspaceId = rawWorkspaceId as Id;

  // 4) Only now -- signature verified -- does the body ever reach a parser.
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!isValidWebhookBody(parsedBody)) {
    return new Response(null, { status: 400 });
  }

  const pool = createDbPool(process.env["DATABASE_URL"] ?? "");
  try {
    // 5) Every write happens inside one withTenant scope for this
    // workspace -- RLS ENABLED and FORCED on integration, credential_
    // reference, webhook_delivery, event and metric (infra/migrations/
    // 0028_integration.sql) means a session scoped to any other workspace
    // literally cannot see or write these rows; this is not "the query
    // happens to filter by workspace_id", it is enforced by PostgreSQL
    // itself even against a bug in the SQL below (T7: "the ingested event
    // lands in the right workspace with RLS forced").
    await withTenant(pool, workspaceId, async (tx) => {
      for (const event of parsedBody.events) {
        await handleIngestEvent(event, buildDeps(tx, workspaceId, event));
      }
    });
  } finally {
    await pool.end();
  }

  return new Response(null, { status: 200 });
}

function getWebhookSecret(): string | null {
  // M0/M1 has exactly one sandbox Meta app (invariant #11: "Meta chỉ
  // sandbox/dry-run") -- one shared HMAC secret for the whole sandbox is
  // how Meta's real X-Hub-Signature-256 scheme actually works too (one
  // secret per Meta App, not one per Page/workspace); this is not a
  // shortcut relative to production, it is the real architecture.
  const value = process.env["META_WEBHOOK_SECRET"];
  return value !== undefined && value.length > 0 ? value : null;
}

interface WebhookBody {
  events: IngestEventPayload[];
}

function isValidWebhookBody(value: unknown): value is WebhookBody {
  if (typeof value !== "object" || value === null) return false;
  const events = (value as Record<string, unknown>)["events"];
  return Array.isArray(events) && events.every(isValidEventPayload);
}

function isValidEventPayload(value: unknown): value is IngestEventPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["externalId"] === "string" &&
    v["externalId"].length > 0 &&
    typeof v["eventType"] === "string" &&
    v["eventType"].length > 0 &&
    typeof v["value"] === "number" &&
    Number.isFinite(v["value"]) &&
    typeof v["occurredAt"] === "string" &&
    typeof v["deliveryId"] === "string" &&
    v["deliveryId"].length > 0
  );
}

function buildDeps(tx: TenantTx, workspaceId: Id, event: IngestEventPayload): IngestEventDeps {
  return {
    async findPublicationByExternalId(externalId) {
      const r = await tx.query(
        `select id, workspace_id, campaign_id from publication where workspace_id = $1 and external_id = $2 limit 1`,
        [workspaceId, externalId],
      );
      const row = r.rows[0] as { id: string; workspace_id: string; campaign_id: string } | undefined;
      if (row === undefined) return null;
      return { id: row.id as Id, workspaceId: row.workspace_id as Id, campaignId: row.campaign_id as Id };
    },
    async recordDelivery(deliveryId) {
      const r = await tx.query(
        `insert into webhook_delivery (id, workspace_id, provider, external_id, signature_ok, payload)
         values ($1, $2, $3, $4, true, $5::jsonb)
         on conflict (workspace_id, provider, external_id) do nothing
         returning id`,
        [newId(), workspaceId, PROVIDER, deliveryId, JSON.stringify(event)],
      );
      return r.rows.length > 0;
    },
    async insertEvent(input) {
      await tx.query(
        `insert into event (id, workspace_id, publication_id, event_type, payload, occurred_at)
         values ($1, $2, $3, $4, $5::jsonb, $6)`,
        [
          newId(),
          input.workspaceId,
          input.publicationId,
          input.eventType,
          JSON.stringify(input.payload),
          input.occurredAt,
        ],
      );
    },
    async upsertMetric(input) {
      // A fresh row per observation (a time series point), not a literal SQL
      // UPSERT overwriting a single value -- `metric` has no unique key to
      // upsert against, and a history of freshness-stamped observations is
      // more honest than one mutable summary cell (ADR-005).
      await tx.query(
        `insert into metric (id, workspace_id, campaign_id, name, value, freshness_at,
                              attribution_model, attribution_window, confidence)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          newId(),
          input.workspaceId,
          input.campaignId,
          input.name,
          input.value,
          input.freshnessAt,
          input.attributionModel,
          input.attributionWindow,
          input.confidence,
        ],
      );
    },
  };
}
