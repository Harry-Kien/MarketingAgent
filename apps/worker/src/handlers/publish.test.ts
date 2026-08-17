// P4 Task 5: the last gate before anything leaves the system.
//
// Every check in handlePublish is a REFUSAL to call the adapter, never a
// warning. In particular (per the P4 track brief, non-negotiable):
//   1. Nothing is published without a recorded human approval decision by a
//      `user` actor -- handlePublish checks the actual loaded
//      ApprovalDecision, never a boolean flag it computed itself.
//   2. Every outbound call goes through the injected ChannelAdapter (which,
//      in production, is backed by guardedFetch, see packages/integrations).
//      This file never imports fetch/guardedFetch at all -- there is
//      structurally no other way for a byte to leave this module.
//   3. No real network request and no real credential -- `deps.adapter` is a
//      hand-written test double throughout; nothing here ever touches the
//      fake Meta server or a socket.
import { describe, expect, it, vi } from "vitest";
import { hashPublicationContent, newId, type Id } from "@smos/domain";
import { AdapterError, type ChannelAdapter, type PublishResult } from "@smos/integrations";
import {
  handlePublish,
  type LoadedApprovalDecision,
  type PublicationRecord,
  type PublishDeps,
} from "./publish.ts";

const content = "Bài đăng đã duyệt";

function makePublication(over: Partial<PublicationRecord> = {}): PublicationRecord {
  return {
    id: newId(),
    workspaceId: newId(),
    campaignId: newId(),
    contentVersionId: newId(),
    approvalDecisionId: newId(),
    publicationContent: content,
    contentHash: hashPublicationContent(content),
    idempotencyKey: newId(),
    targetChannel: "meta_page",
    targetAccountId: "page-1",
    state: "prepared",
    ...over,
  };
}

/** A well-formed decision matching `pub`: a real user actor, approved, for
 * exactly `pub`'s content version and workspace -- the "everything is
 * legitimate" baseline every adversarial test below mutates one field of. */
function makeDecision(pub: PublicationRecord, over: Partial<LoadedApprovalDecision> = {}): LoadedApprovalDecision {
  return {
    id: newId(),
    workspaceId: pub.workspaceId,
    approvalRequestId: newId(),
    actorUserId: newId(),
    decision: "approve",
    contentVersionId: pub.contentVersionId,
    targetChannel: pub.targetChannel,
    ...over,
  };
}

function makeAdapter(over: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    name: "meta",
    healthCheck: async () => true,
    publish: vi.fn(async (): Promise<PublishResult> => ({
      externalId: "page-1_9",
      permalink: "https://sandbox.meta.test/page-1_9",
      evidence: { requestId: "req-9" },
    })),
    ...over,
  };
}

function makeDeps(pub: PublicationRecord, over: Partial<PublishDeps> = {}): PublishDeps {
  return {
    loadPublication: async () => pub,
    loadApprovalDecision: async () => makeDecision(pub),
    adapter: makeAdapter(),
    markExecuting: vi.fn(async () => true),
    markSucceeded: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    writeAudit: vi.fn(async () => undefined),
    ...over,
  };
}

describe("handlePublish", () => {
  it("publishes when the approval decision is a real, matching, approved user decision and the hash matches", async () => {
    const pub = makePublication();
    const deps = makeDeps(pub);
    const job = { publicationId: pub.id, workspaceId: pub.workspaceId };
    await handlePublish(job, deps);
    expect(deps.adapter.publish).toHaveBeenCalledOnce();
    expect(deps.markExecuting).toHaveBeenCalledWith(pub.id);
    expect(deps.markSucceeded).toHaveBeenCalledOnce();
    expect(deps.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "publication.succeeded", subjectId: pub.id }),
    );
  });

  it("refuses when there is no approval decision, and never calls the adapter", async () => {
    const pub = makePublication();
    const deps = makeDeps(pub, { loadApprovalDecision: async () => null });
    const job = { publicationId: pub.id, workspaceId: pub.workspaceId };
    await expect(handlePublish(job, deps)).rejects.toThrow(/approval/i);
    expect(deps.adapter.publish).not.toHaveBeenCalled();
    expect(deps.markExecuting).not.toHaveBeenCalled();
  });

  it("refuses when the decision was a rejection", async () => {
    const pub = makePublication();
    const deps = makeDeps(pub, { loadApprovalDecision: async () => makeDecision(pub, { decision: "reject" }) });
    const job = { publicationId: pub.id, workspaceId: pub.workspaceId };
    await expect(handlePublish(job, deps)).rejects.toThrow(/approved/i);
    expect(deps.adapter.publish).not.toHaveBeenCalled();
  });

  it("refuses when the decision was 'request_changes'", async () => {
    const pub = makePublication();
    const deps = makeDeps(pub, {
      loadApprovalDecision: async () => makeDecision(pub, { decision: "request_changes" }),
    });
    const job = { publicationId: pub.id, workspaceId: pub.workspaceId };
    await expect(handlePublish(job, deps)).rejects.toThrow(/approved/i);
    expect(deps.adapter.publish).not.toHaveBeenCalled();
  });

  // Adversarial attempt: "approval by an agent or system actor". The
  // database can never produce such a row (0007_approval.sql's FK to
  // user_account plus its actor_kind CHECK), but the handler's deps are an
  // injected interface -- if a future, misimplemented loader ever handed
  // back a decision with no real user id, the handler itself must still
  // refuse, not merely trust that the object exists.
  it("refuses when the decision has no recorded user actor -- never trusts a flag it computed itself", async () => {
    const pub = makePublication();
    const badDecision = { ...makeDecision(pub), actorUserId: undefined } as unknown as LoadedApprovalDecision;
    const deps = makeDeps(pub, { loadApprovalDecision: async () => badDecision });
    const job = { publicationId: pub.id, workspaceId: pub.workspaceId };
    await expect(handlePublish(job, deps)).rejects.toThrow(/user|actor/i);
    expect(deps.adapter.publish).not.toHaveBeenCalled();
  });

  it("refuses when the decision's actorUserId is not a well-formed id (e.g. an agent run id shape)", async () => {
    const pub = makePublication();
    const badDecision = { ...makeDecision(pub), actorUserId: "not-a-real-id" } as unknown as LoadedApprovalDecision;
    const deps = makeDeps(pub, { loadApprovalDecision: async () => badDecision });
    const job = { publicationId: pub.id, workspaceId: pub.workspaceId };
    await expect(handlePublish(job, deps)).rejects.toThrow(/user|actor/i);
    expect(deps.adapter.publish).not.toHaveBeenCalled();
  });

  // Adversarial attempt: approval decision belonging to a different workspace.
  it("refuses when the approval decision belongs to a different workspace than the publication", async () => {
    const pub = makePublication();
    const deps = makeDeps(pub, {
      loadApprovalDecision: async () => makeDecision(pub, { workspaceId: newId() }),
    });
    const job = { publicationId: pub.id, workspaceId: pub.workspaceId };
    await expect(handlePublish(job, deps)).rejects.toThrow(/workspace/i);
    expect(deps.adapter.publish).not.toHaveBeenCalled();
  });

  // Adversarial attempt: approval decision belonging to a different content version.
  it("refuses when the approval decision was recorded for a different content version", async () => {
    const pub = makePublication();
    const deps = makeDeps(pub, {
      loadApprovalDecision: async () => makeDecision(pub, { contentVersionId: newId() }),
    });
    const job = { publicationId: pub.id, workspaceId: pub.workspaceId };
    await expect(handlePublish(job, deps)).rejects.toThrow(/content version/i);
    expect(deps.adapter.publish).not.toHaveBeenCalled();
  });

  it("refuses when the content drifted after approval", async () => {
    const pub = makePublication({ contentHash: "hash-of-something-else" });
    const deps = makeDeps(pub);
    const job = { publicationId: pub.id, workspaceId: pub.workspaceId };
    await expect(handlePublish(job, deps)).rejects.toThrow(/drift|hash/i);
    expect(deps.adapter.publish).not.toHaveBeenCalled();
  });

  it("does not auto-retry a permanent failure", async () => {
    const pub = makePublication();
    const publishMock = vi.fn(async () => { throw new AdapterError("invalid_input", "bad"); });
    const deps = makeDeps(pub, { adapter: makeAdapter({ publish: publishMock }) });
    const job = { publicationId: pub.id, workspaceId: pub.workspaceId };
    await expect(handlePublish(job, deps)).rejects.toThrow();
    expect(publishMock).toHaveBeenCalledOnce();
    expect(deps.markFailed).toHaveBeenCalledWith(pub.id, expect.objectContaining({ retryable: false }));
    expect(deps.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "publication.failed", subjectId: pub.id }),
    );
  });

  it("wraps a non-AdapterError thrown by the adapter as upstream_unavailable, never a fake success", async () => {
    const pub = makePublication();
    const publishMock = vi.fn(async () => { throw new Error("socket reset"); });
    const deps = makeDeps(pub, { adapter: makeAdapter({ publish: publishMock }) });
    const job = { publicationId: pub.id, workspaceId: pub.workspaceId };
    await expect(handlePublish(job, deps)).rejects.toThrow();
    expect(deps.markFailed).toHaveBeenCalledWith(pub.id, expect.objectContaining({ kind: "upstream_unavailable" }));
  });

  it("refuses to publish twice for the same publication (already succeeded), without calling the adapter", async () => {
    const pub = makePublication({ state: "succeeded" });
    const deps = makeDeps(pub);
    const job = { publicationId: pub.id, workspaceId: pub.workspaceId };
    await handlePublish(job, deps);
    expect(deps.adapter.publish).not.toHaveBeenCalled();
    expect(deps.markExecuting).not.toHaveBeenCalled();
  });

  // Adversarial attempt: racing approval-check and publish. Two concurrent
  // handlePublish calls for the SAME publication could both read
  // state="prepared" before either transitions it -- a classic TOCTOU that
  // would let both call the adapter and post twice. markExecuting's return
  // value is the real guard: a production implementation performs one atomic
  // `UPDATE publication SET state='executing' WHERE id=$1 AND
  // state='prepared'` and reports whether IT won the race.
  it("refuses to call the adapter when markExecuting reports it lost the race to another concurrent call", async () => {
    const pub = makePublication();
    const markExecuting = vi.fn(async () => false);
    const deps = makeDeps(pub, { markExecuting });
    const job = { publicationId: pub.id, workspaceId: pub.workspaceId };
    await handlePublish(job, deps);
    expect(markExecuting).toHaveBeenCalledOnce();
    expect(deps.adapter.publish).not.toHaveBeenCalled();
    expect(deps.markSucceeded).not.toHaveBeenCalled();
  });

  it("refuses when the publication's workspaceId does not match the job's workspaceId", async () => {
    const pub = makePublication();
    const deps = makeDeps(pub);
    const job = { publicationId: pub.id, workspaceId: newId() };
    await expect(handlePublish(job, deps)).rejects.toThrow(/workspace/i);
    expect(deps.adapter.publish).not.toHaveBeenCalled();
  });

  it("throws when the publication does not exist", async () => {
    const pub = makePublication();
    const deps = makeDeps(pub, { loadPublication: async () => null });
    const job = { publicationId: newId(), workspaceId: newId() };
    await expect(handlePublish(job, deps)).rejects.toThrow(/not found/i);
    expect(deps.adapter.publish).not.toHaveBeenCalled();
  });

  // Late-review CRITICAL 1, handler half. The database now freezes
  // approval_request once decided, but this gate must independently refuse a
  // mismatch, because `deps` is an injected interface -- not necessarily this
  // database (publish.ts's own standing rule for the content-hash check).
  it("refuses to spend an approval granted for a different target channel", async () => {
    const pub = makePublication({ targetChannel: "tiktok_account" });
    const deps = makeDeps(pub, {
      // Approved for meta_page; the publication points at tiktok_account.
      loadApprovalDecision: async () => makeDecision(pub, { targetChannel: "meta_page" }),
    });
    const job = { publicationId: pub.id, workspaceId: pub.workspaceId };
    await expect(handlePublish(job, deps)).rejects.toThrow(/target channel/i);
    expect(deps.adapter.publish).not.toHaveBeenCalled();
    expect(deps.markExecuting).not.toHaveBeenCalled();
  });
});
