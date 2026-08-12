import type { Id } from "@smos/domain";

/**
 * The flat shape this handler consumes. `route.ts` (apps/web) is
 * responsible for turning Meta's real, nested webhook envelope
 * (`{ object, entry: [...] }`) into one of these per reportable change --
 * this handler never sees the raw provider wire format, only the already-
 * normalized event.
 */
export interface IngestEventPayload {
  externalId: string;
  eventType: string;
  value: number;
  occurredAt: string;
  deliveryId: string;
}

export interface ResolvedPublication {
  id: Id;
  workspaceId: Id;
  campaignId: Id;
}

export interface InsertEventInput {
  workspaceId: Id;
  publicationId: Id;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface UpsertMetricInput {
  workspaceId: Id;
  campaignId: Id;
  name: string;
  value: number;
  freshnessAt: Date;
  attributionModel: string;
  attributionWindow: string;
  confidence: "low" | "medium" | "high";
}

export interface IngestEventDeps {
  findPublicationByExternalId(externalId: string): Promise<ResolvedPublication | null>;
  /**
   * Task 7 replay defense: the nonce is `deliveryId`, one per distinct
   * webhook delivery attempt. A real Postgres-backed implementation is an
   * `INSERT ... ON CONFLICT (workspace_id, provider, external_id) DO
   * NOTHING RETURNING id` against `webhook_delivery` -- returns `true` the
   * first time a given delivery id is seen, `false` on every repeat.
   * Because that row is never deleted (smos_app has no DELETE grant on
   * webhook_delivery, infra/migrations/0028_integration.sql), a captured
   * valid request becomes permanently non-reprocessable after the first
   * successful call, not merely non-reprocessable within a rolling time
   * window. See ingest-event's header comment for why a *time*-based
   * window was deliberately not layered on top of this.
   */
  recordDelivery(deliveryId: string): Promise<boolean>;
  insertEvent(input: InsertEventInput): Promise<void>;
  upsertMetric(input: UpsertMetricInput): Promise<void>;
}

/**
 * Maps a provider event type to the metric name the analytics view reads.
 * Unknown event types still get a metric (using the event type itself as
 * the name) rather than being silently dropped -- an operator seeing an
 * unfamiliar metric name is better than an operator missing data with no
 * trace of why.
 */
const METRIC_NAME_BY_EVENT_TYPE: Record<string, string> = {
  "post.impression": "reach",
  "post.engagement": "engagement",
};

function metricNameFor(eventType: string): string {
  return METRIC_NAME_BY_EVENT_TYPE[eventType] ?? eventType;
}

/**
 * Task 7: turn one already-signature-verified, already-parsed provider
 * event into a stored `event` row and an updated `metric` point.
 *
 * Ordering is deliberate:
 * 1. `recordDelivery` first, always -- a replayed valid delivery is
 *    rejected as cheaply as possible (one indexed upsert), before ever
 *    touching `publication`, `event` or `metric`.
 * 2. `findPublicationByExternalId` -- an event for a `externalId` this
 *    workspace has no matching publication for yet (out-of-order delivery)
 *    is dropped, not guessed at or attached to the wrong campaign.
 * 3. Only once both of those pass does anything get written.
 *
 * `attributionModel`/`attributionWindow`/`confidence` are never omitted
 * (ADR-005, mirrored by `metric`'s own NOT NULL columns,
 * infra/migrations/0028_integration.sql): a metric that cannot state its
 * freshness and attribution must not exist. `confidence` is `"medium"`,
 * deliberately -- a single webhook ping is real, verified data, but one
 * data point with no accumulated history is not `"high"` confidence
 * either.
 */
export async function handleIngestEvent(payload: IngestEventPayload, deps: IngestEventDeps): Promise<void> {
  const isNewDelivery = await deps.recordDelivery(payload.deliveryId);
  if (!isNewDelivery) return;

  const publication = await deps.findPublicationByExternalId(payload.externalId);
  if (publication === null) return;

  const occurredAt = new Date(payload.occurredAt);

  await deps.insertEvent({
    workspaceId: publication.workspaceId,
    publicationId: publication.id,
    eventType: payload.eventType,
    payload: { value: payload.value },
    occurredAt,
  });

  await deps.upsertMetric({
    workspaceId: publication.workspaceId,
    campaignId: publication.campaignId,
    name: metricNameFor(payload.eventType),
    value: payload.value,
    freshnessAt: new Date(),
    attributionModel: "last_touch",
    attributionWindow: "7d",
    confidence: "medium",
  });
}
