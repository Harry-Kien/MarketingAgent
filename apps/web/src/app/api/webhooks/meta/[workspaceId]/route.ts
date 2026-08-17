import { createHash } from "node:crypto";
import { isId, newId, type Id } from "@smos/domain";
import { withTenant, type TenantTx } from "@smos/db";
import { handleIngestEvent, type IngestEventDeps, type IngestEventPayload } from "@smos/worker";
import { logger } from "@smos/telemetry";
import { getPool } from "../../../../../server/db.ts";
import { deriveWorkspaceSecret, verifySignature } from "../../../../../server/webhook-signature.ts";
import { MAX_EVENTS_PER_DELIVERY } from "../../../../../server/webhook-limits.ts";
import { checkWebhookRateLimit, extractClientIp } from "../../../../../server/webhook-rate-limit.ts";
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
 * rather than one single global endpoint. Late-review CRITICAL 2 found that
 * this scoping was, until now, PURELY ROUTING: one global
 * `META_WEBHOOK_SECRET` signed every delivery and the workspace id in the
 * path was not covered by that signature at all, so workspace A's captured
 * `(body, sha256=...)` replayed at workspace B's URL verified, returned 200,
 * and wrote A's payload and A's Meta post id into B's `webhook_delivery` --
 * permanently burning that delivery id for B, because `deliveryId` is the
 * replay nonce and the row can never be deleted. The signature is now
 * derived per workspace (`deriveWorkspaceSecret`, whose header records why a
 * per-workspace secret was chosen over signing `wsId + body`), so the
 * workspace a request claims to be for is bound into what was signed and a
 * cross-tenant replay cannot verify at all.
 *
 * The other half of that fix lives at the database: the replay nonce is now
 * a PARTIAL unique index restricted to `signature_ok` rows
 * (0032_webhook_delivery_nonce_and_audit.sql), so a rejected delivery --
 * including the audit receipt this route now writes for one -- can never
 * consume an id a genuine delivery will later need.
 *
 * Hardening task 1: late-findings-fix-report.md's own "Concerns" section
 * named the gap 0032 left open -- "an attacker who can reach the webhook
 * with a valid-looking workspace id can add one signature_ok = false row
 * per DISTINCT forged body. Identical replays collapse (partial unique
 * index), distinct ones do not." The rate-limit gate below
 * (../../../../../server/webhook-rate-limit.ts) runs immediately after
 * signature verification and BEFORE any row is ever written for this
 * request -- a throttled request never reaches `recordRejectedDelivery`,
 * so distinct forged bodies can no longer buy unbounded rows; the
 * limiter's own storage is separately bounded by fixed-cardinality hash
 * buckets (see that module's and 0035's headers). Valid and invalid
 * traffic are checked against completely disjoint scopes, which is what
 * keeps this gate itself from becoming a new way to deny a genuine sender
 * service: forging signatures can only ever exhaust an `invalid_*` bucket,
 * never the `valid_workspace` bucket a real sender's own traffic depends
 * on -- see webhook-rate-limit.test.ts and route.test.ts's own rate-limit
 * tests for the live proof.
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

  // 2) Verify the signature over the exact raw bytes received, under the
  // secret for the workspace this request CLAIMS to be for -- so that claim
  // is itself part of what was signed. A missing root secret (misconfigured
  // server) fails exactly like a bad signature, never "skip verification".
  const signatureHeader = request.headers.get(SIGNATURE_HEADER) ?? "";
  const rootSecret = getWebhookRootSecret();
  const workspaceSecret = rootSecret === null ? null : deriveWorkspaceSecret(rootSecret, rawWorkspaceId);
  const signatureOk = workspaceSecret !== null && verifySignature(rawBody, signatureHeader, workspaceSecret);
  const pool = getPool();

  // 2b) Hardening task 1: rate limit BEFORE any webhook_delivery row is
  // ever written for this request -- genuine or rejected -- so a throttled
  // request never occupies a nonce slot or a rejected-receipt row.
  // Signature-valid and signature-invalid requests are checked against
  // completely disjoint scopes (webhook-rate-limit.ts's own header): a
  // valid request only ever touches `valid_workspace`, keyed on the
  // workspace, and can ONLY be reached by someone who already holds that
  // workspace's derived secret; an invalid one is checked against THREE
  // scopes at once -- the caller's IP (catches a single-source flood even
  // with no valid workspace id at all), the claimed workspace id if it is
  // at least well-formed (catches a distributed flood aimed at one
  // tenant), and one single global bucket (catches a flood distributed
  // across many IPs AND many fabricated workspace ids, so no per-key
  // budget alone ever trips). None of the three invalid scopes can ever
  // touch `valid_workspace`, so no volume of forged traffic can exhaust a
  // genuine sender's own budget for their own workspace.
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
    // 429, never a silent drop, and never a delivery/receipt row: Meta (and
    // any well-behaved sender) retries a 429 with backoff, so a genuine
    // delivery that arrives while a budget is exhausted is delayed, never
    // permanently lost -- the same failure mode CRITICAL 2's nonce-burn fix
    // closed, reproduced here in a new shape, closed the same way: nothing
    // about a throttled request is ever recorded as having happened.
    logger.warn("webhook rate limit exceeded; throttling before any delivery row is written", {
      workspaceId: rawWorkspaceId,
      signatureOk,
    });
    return new Response(null, {
      status: 429,
      headers: { "Retry-After": String(throttledRetryAfterSeconds) },
    });
  }

  if (!signatureOk) {
    // Never the raw body, never the signature value -- only a fixed-size
    // digest, so a forged giant or secret-shaped payload never leaves a
    // trace bigger than one fingerprint (T7: "never logged in full").
    const bodyDigest = createHash("sha256").update(rawBody).digest("hex");
    logger.warn("webhook signature verification failed", {
      workspaceId: rawWorkspaceId,
      bodyDigest: bodyDigest.slice(0, 16),
      hadSignatureHeader: signatureHeader.length > 0,
    });
    await recordRejectedDelivery(rawWorkspaceId, bodyDigest);
    return new Response(null, { status: 401 });
  }

  // 3) Only a signature-verified request's workspace id is trusted enough
  // to route with. isId is a pure shape check (well-formed UUIDv7), not an
  // existence check -- step 5 is the existence check.
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
  // MINOR (a): a 690 KB body carrying 4000 events fits well inside the byte
  // cap but held ONE transaction open for 24.3 seconds. Bytes are the wrong
  // unit for that cost; round trips are. Refused before a pool connection is
  // even checked out.
  if (parsedBody.events.length > MAX_EVENTS_PER_DELIVERY) {
    logger.warn("webhook batch exceeded the per-delivery event cap; refused before any write", {
      workspaceId,
      eventCount: parsedBody.events.length,
    });
    return new Response(null, { status: 400 });
  }

  // MINOR (a), second half: one process-wide pool (apps/web/src/server/db.ts),
  // not a fresh `pg.Pool` per request -- `pool` was already resolved above,
  // before the rate-limit gate, for that same reason (the old code built and
  // tore down a pool on every single delivery, so a burst of webhooks opened
  // a burst of brand-new connections against a database whose connection
  // count is the scarcest thing it has).

  // 5) MINOR (b): this route's own comment used to promise that an id which
  // merely LOOKS valid but names no real workspace would "fail at the FK,
  // never silently". It did fail -- as an unhandled throw carrying the raw
  // constraint name out to the caller. A well-formed id naming no workspace
  // is a 404, decided here, explicitly. `workspace` is the tenant root: it
  // carries no workspace_id and no RLS policy (0001_core_tenancy.sql), so
  // this read is correct outside a tenant scope and is the only such read in
  // this file.
  const exists = await pool.query(`select 1 from workspace where id = $1`, [workspaceId]);
  if (exists.rowCount === 0) {
    return new Response(null, { status: 404 });
  }

  // 6) Every write happens inside one withTenant scope for this
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

  return new Response(null, { status: 200 });
}

function getWebhookRootSecret(): string | null {
  // M0/M1 has exactly one sandbox Meta app (invariant #11: "Meta chỉ
  // sandbox/dry-run"), so there is one configured secret. It is the ROOT of
  // a per-workspace derivation, never the signing key itself -- see
  // deriveWorkspaceSecret for why that distinction is the whole fix.
  const value = process.env["META_WEBHOOK_SECRET"];
  return value !== undefined && value.length > 0 ? value : null;
}

/**
 * MINOR (c): `webhook_delivery.signature_ok` was never written `false`, so
 * the audit trail 0028_integration.sql's own header describes ("one row per
 * inbound webhook, whether or not its signature verified ... a rejected
 * signature is exactly the kind of event an audit trail must not omit")
 * simply did not exist.
 *
 * Three properties this receipt must have, all load-bearing:
 *
 *  - It must NOT consume the delivery id the forgery claimed. It cannot:
 *    the body is never parsed on this path (parsing unverified bytes is the
 *    thing the route's ordering exists to prevent), so the claimed id is not
 *    even known here -- the receipt is keyed on the body digest instead --
 *    and even on a collision the nonce index is partial on `signature_ok`
 *    (0032), so rejected and verified rows occupy disjoint key spaces.
 *  - It must never store the rejected body. `payload` stays `{}`; only the
 *    digest is kept, which is what the log line already carries.
 *  - It must never turn a 401 into a 500. Everything here is best effort: a
 *    malformed workspace id, a workspace that does not exist, an RLS refusal
 *    or a duplicate are all swallowed and the caller still gets 401.
 *
 * Known limit, stated rather than hidden: an attacker who can reach this
 * endpoint with a valid-looking workspace id can add one row per DISTINCT
 * forged body. Identical replays collapse (the partial unique index), but
 * distinct bodies do not. Rate limiting is the real answer and there is none
 * in this milestone; the same is true of every other route here.
 */
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
      ),
    );
  } catch (error) {
    logger.warn("could not record a rejected webhook delivery receipt", {
      workspaceId: rawWorkspaceId,
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
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
    // MINOR (b): `occurredAt` was validated only as `typeof === "string"`, so
    // "not-a-date" passed, became an Invalid Date, and escaped as an
    // unhandled throw out of the INSERT. A timestamp that does not parse is
    // malformed input -- a 400, decided here, like every other shape error.
    typeof v["occurredAt"] === "string" &&
    Number.isFinite(Date.parse(v["occurredAt"])) &&
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
      // ON CONFLICT names the partial index's predicate (`where
      // signature_ok`), so this claims the nonce only against OTHER VERIFIED
      // deliveries -- a rejected receipt sitting on the same key can never
      // make this return false. That is the burn fix, expressed in the one
      // query that decides whether a delivery is new.
      const r = await tx.query(
        `insert into webhook_delivery (id, workspace_id, provider, external_id, signature_ok, payload)
         values ($1, $2, $3, $4, true, $5::jsonb)
         on conflict (workspace_id, provider, external_id) where signature_ok do nothing
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
