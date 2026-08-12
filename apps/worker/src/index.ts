// Public surface of @smos/worker for callers outside this app -- today just
// apps/web's webhook route, which needs handleIngestEvent (Task 7) to turn a
// signature-verified payload into real event/metric rows. Mirrors every
// other package's own src/index.ts convention (packages/db, packages/
// integrations, packages/telemetry, ...); apps/worker's own process entry
// point (main.ts) is unaffected and does not import through this file.
export {
  handleIngestEvent,
  type IngestEventDeps,
  type IngestEventPayload,
  type InsertEventInput,
  type ResolvedPublication,
  type UpsertMetricInput,
} from "./handlers/ingest-event.ts";
export {
  handlePublish,
  type LoadedApprovalDecision,
  type PublicationRecord,
  type PublishDeps,
} from "./handlers/publish.ts";
