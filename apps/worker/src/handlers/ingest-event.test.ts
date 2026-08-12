import { describe, expect, it, vi } from "vitest";
import { newId } from "@smos/domain";
import { handleIngestEvent } from "./ingest-event.ts";

const deps = (over = {}) => ({
  findPublicationByExternalId: async () => ({ id: newId(), workspaceId: newId(), campaignId: newId() }),
  recordDelivery: vi.fn(async () => true),
  insertEvent: vi.fn(async () => undefined),
  upsertMetric: vi.fn(async () => undefined),
  ...over,
});

describe("handleIngestEvent", () => {
  it("stores the event and updates a metric with freshness", async () => {
    const d = deps();
    await handleIngestEvent(
      { externalId: "page-1_9", eventType: "post.impression", value: 120, occurredAt: new Date().toISOString(), deliveryId: "d1" },
      d,
    );
    expect(d.insertEvent).toHaveBeenCalledOnce();
    expect(d.upsertMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        freshnessAt: expect.any(Date),
        attributionModel: expect.any(String),
        confidence: expect.any(String),
      }),
    );
  });

  it("is idempotent on repeated delivery ids", async () => {
    const d = deps({ recordDelivery: vi.fn(async () => false) });
    await handleIngestEvent(
      { externalId: "page-1_9", eventType: "post.impression", value: 1, occurredAt: new Date().toISOString(), deliveryId: "d1" },
      d,
    );
    expect(d.insertEvent).not.toHaveBeenCalled();
  });

  it("ignores an event for an unknown publication rather than guessing", async () => {
    const d = deps({ findPublicationByExternalId: async () => null });
    await handleIngestEvent(
      { externalId: "unknown", eventType: "post.impression", value: 1, occurredAt: new Date().toISOString(), deliveryId: "d2" },
      d,
    );
    expect(d.insertEvent).not.toHaveBeenCalled();
  });

  it("checks for a duplicate delivery before ever resolving the publication, so a replayed valid request costs one cheap lookup, not a full write path", async () => {
    const findPublicationByExternalId = vi.fn(async () => null);
    const d = deps({ recordDelivery: vi.fn(async () => false), findPublicationByExternalId });
    await handleIngestEvent(
      { externalId: "page-1_9", eventType: "post.impression", value: 1, occurredAt: new Date().toISOString(), deliveryId: "d1" },
      d,
    );
    expect(findPublicationByExternalId).not.toHaveBeenCalled();
  });

  it("never calls upsertMetric when the event is dropped (unknown publication)", async () => {
    const d = deps({ findPublicationByExternalId: async () => null });
    await handleIngestEvent(
      { externalId: "unknown", eventType: "post.impression", value: 1, occurredAt: new Date().toISOString(), deliveryId: "d3" },
      d,
    );
    expect(d.upsertMetric).not.toHaveBeenCalled();
  });

  it("passes the publication's own workspace and campaign through to the event and metric, never a caller-guessed one", async () => {
    const wsId = newId();
    const campaignId = newId();
    const pubId = newId();
    const d = deps({ findPublicationByExternalId: async () => ({ id: pubId, workspaceId: wsId, campaignId }) });
    await handleIngestEvent(
      { externalId: "page-1_9", eventType: "post.impression", value: 5, occurredAt: new Date().toISOString(), deliveryId: "d4" },
      d,
    );
    expect(d.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: wsId, publicationId: pubId }),
    );
    expect(d.upsertMetric).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: wsId, campaignId }),
    );
  });
});
