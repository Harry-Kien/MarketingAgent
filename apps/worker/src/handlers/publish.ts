import { hashPublicationContent, isId, type Id } from "@smos/domain";
import { AdapterError, type ChannelAdapter, type PublishResult } from "@smos/integrations";
import { logger, withSpan } from "@smos/telemetry";

/**
 * The publication row as loaded from storage -- wider than the domain
 * `Publication` type (packages/domain/src/publication.ts), whose `state` is
 * pinned to the single literal `"prepared"` because that type only ever
 * describes a freshly-built publication. This mirrors what the row actually
 * looks like once its execution lifecycle (infra/migrations/0010_publication.sql)
 * has started moving it through prepared -> executing -> succeeded/failed.
 *
 * `targetAccountId` has no column of its own on `publication`
 * (0010_publication.sql only carries `target_channel`) -- deriving the
 * concrete external account id (e.g. a Meta page id) from the workspace's
 * `integration`/`credential_reference` rows (infra/migrations/0028_integration.sql)
 * is the responsibility of whatever implements `loadPublication` against the
 * real database, which is out of this task's scope (see the File Structure
 * Map: this task owns only the handler and its injected deps).
 */
export interface PublicationRecord {
  id: Id;
  workspaceId: Id;
  campaignId: Id;
  contentVersionId: Id;
  approvalDecisionId: Id;
  publicationContent: string;
  contentHash: string;
  idempotencyKey: string;
  targetChannel: string;
  targetAccountId: string;
  state: "prepared" | "executing" | "succeeded" | "failed";
}

/**
 * What handlePublish needs to know about the recorded approval decision.
 *
 * Late-review CRITICAL 1: `contentVersionId` used to have no column of its
 * own -- a loader obtained it by JOINING through to
 * `approval_request.content_version_id`, i.e. by reading the exact column an
 * attacker holding plain `UPDATE ON approval_request` (0007_approval.sql:66)
 * could rewrite AFTER the decision. The gate below then compared the
 * retargeted value against itself and passed, publishing never-approved text
 * under a genuine human approval. `contentVersionId` and `targetChannel` are
 * now real, NOT NULL columns on `approval_decision` itself -- a whole-row
 * immutable table (0007) whose snapshot is tied to the request it answers by
 * a composite foreign key
 * (infra/migrations/0031_approval_request_frozen_after_decision.sql). Any
 * loader for this interface MUST read both from `approval_decision`; a loader
 * that re-derives either from `approval_request` reintroduces the defect.
 */
export interface LoadedApprovalDecision {
  id: Id;
  workspaceId: Id;
  approvalRequestId: Id;
  actorUserId: Id;
  decision: "approve" | "reject" | "request_changes";
  contentVersionId: Id;
  targetChannel: string;
}

export interface PublishDeps {
  loadPublication(id: Id): Promise<PublicationRecord | null>;
  loadApprovalDecision(id: Id): Promise<LoadedApprovalDecision | null>;
  adapter: ChannelAdapter;
  /**
   * Transitions the publication from "prepared" to "executing". Resolves
   * `true` only if THIS call actually performed that transition. A real
   * implementation does this with one atomic
   * `UPDATE publication SET state = 'executing' WHERE id = $1 AND state = 'prepared'`
   * and reports whether it affected a row -- the only thing that closes the
   * race between two concurrent deliveries of the same publish job (a queue's
   * at-least-once delivery is not, by itself, exactly-once execution).
   * `false` means some other call already claimed (or finished) this
   * publication; the caller must not publish again.
   */
  markExecuting(id: Id): Promise<boolean>;
  markSucceeded(id: Id, result: PublishResult): Promise<void>;
  markFailed(id: Id, error: { kind: string; retryable: boolean; safeMessage: string }): Promise<void>;
  writeAudit(event: { eventType: string; subjectId: Id; payload: Record<string, unknown> }): Promise<void>;
}

/**
 * The last gate before anything leaves the system. Every check here is a
 * refusal to call the adapter, never a warning (threats T1, T2). No branch
 * in this function ever imports `fetch` or a network client directly --
 * `deps.adapter` (a `ChannelAdapter`, backed in production by `guardedFetch`,
 * see packages/integrations) is the only way a byte can leave here.
 */
export async function handlePublish(
  job: { publicationId: Id; workspaceId: Id },
  deps: PublishDeps,
): Promise<void> {
  const pub = await deps.loadPublication(job.publicationId);
  if (pub === null) {
    throw new Error(`Publication ${job.publicationId} not found`);
  }
  // Defense in depth beyond RLS: a misimplemented loader that forgot to
  // scope its query by workspace must still be caught here, before any
  // approval or publish decision is made on its behalf.
  if (pub.workspaceId !== job.workspaceId) {
    throw new Error(
      `Publication ${pub.id} belongs to workspace ${pub.workspaceId}, not job workspace ${job.workspaceId}; refusing to publish`,
    );
  }
  if (pub.state === "succeeded") {
    logger.info("publication already succeeded; skipping", { publicationId: pub.id });
    return;
  }

  // The real recorded decision -- never a boolean the caller computed, and
  // never trusted merely because `publication.approval_decision_id` is set
  // (that column being NOT NULL only proves a row id was recorded at
  // publication-creation time, not that the decision it points at still
  // says "approve" by a real user for this exact content).
  const decision = await deps.loadApprovalDecision(pub.approvalDecisionId);
  if (decision === null) {
    throw new Error("Approval decision not found; refusing to publish");
  }
  if (decision.workspaceId !== pub.workspaceId) {
    throw new Error("Approval decision belongs to a different workspace; refusing to publish");
  }
  // `isId` requires the well-formed shape `newId()` produces -- a real user
  // row's primary key. An agent or system actor can never satisfy this: the
  // database itself never lets one exist on approval_decision
  // (0007_approval.sql's FK to user_account plus its actor_kind CHECK), and
  // this check refuses the same thing again here, independently, in case a
  // future loader implementation ever gets that join wrong.
  if (!isId(decision.actorUserId)) {
    throw new Error("Approval decision has no recorded user actor; refusing to publish");
  }
  if (decision.decision !== "approve") {
    throw new Error(`Approval decision is "${decision.decision}", not approved; refusing to publish`);
  }
  // Both comparisons read the DECISION's own immutable snapshot of what was
  // approved, never the approval_request columns it was raised from (see
  // LoadedApprovalDecision's header). Without the channel check, an approval
  // granted for `meta_page` could be spent publishing to `tiktok_account`:
  // "what was approved" is text AND destination, not text alone.
  if (decision.contentVersionId !== pub.contentVersionId) {
    throw new Error("Approval decision was recorded for a different content version; refusing to publish");
  }
  if (decision.targetChannel !== pub.targetChannel) {
    throw new Error(
      `Approval decision was recorded for target channel "${decision.targetChannel}", not "${pub.targetChannel}"; refusing to publish`,
    );
  }
  // Content could have drifted between approval and execution. Redundant
  // with the database's own immutability trigger and CHECK
  // (infra/migrations/0011_publication_immutability.sql) for a real
  // Postgres-backed loader, but this handler must not depend on that alone:
  // its `deps` are an injected interface, not necessarily this database.
  if (hashPublicationContent(pub.publicationContent) !== pub.contentHash) {
    throw new Error("Content drift detected: the text no longer matches what was approved");
  }

  const transitioned = await deps.markExecuting(pub.id);
  if (!transitioned) {
    logger.info(
      "publication is already executing or was already handled by a concurrent call; skipping",
      { publicationId: pub.id },
    );
    return;
  }

  try {
    // Task 6: the one place bytes actually leave this process. Wrapped in
    // its own span (never the whole handler) so a trace can distinguish
    // "the approval gate took time" from "the adapter call took time" --
    // attributes carry only identifiers already safe to export (workspace,
    // publication, adapter name, idempotency key), never publicationContent.
    const result = await withSpan(
      "adapter.publish",
      {
        "workspace.id": pub.workspaceId,
        "publication.id": pub.id,
        "adapter.name": deps.adapter.name,
        "idempotency.key": pub.idempotencyKey,
      },
      () =>
        deps.adapter.publish({
          idempotencyKey: pub.idempotencyKey,
          publicationContent: pub.publicationContent,
          contentHash: pub.contentHash,
          targetAccountId: pub.targetAccountId,
        }),
    );
    await deps.markSucceeded(pub.id, result);
    await deps.writeAudit({
      eventType: "publication.succeeded",
      subjectId: pub.id,
      payload: { externalId: result.externalId, permalink: result.permalink },
    });
  } catch (error) {
    // No automatic retry with an external side effect: a duplicate post is
    // worse than a delayed one.
    const e = error instanceof AdapterError ? error : new AdapterError("upstream_unavailable", String(error));
    await deps.markFailed(pub.id, { kind: e.kind, retryable: e.retryable, safeMessage: e.safeMessage });
    await deps.writeAudit({
      eventType: "publication.failed",
      subjectId: pub.id,
      payload: { kind: e.kind, message: e.safeMessage },
    });
    throw e;
  }
}
