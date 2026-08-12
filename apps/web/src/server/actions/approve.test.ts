import { describe, expect, it, vi } from "vitest";
import { newId } from "@smos/domain";
import { performApproval, type PerformApprovalDeps } from "./approve.ts";

const base = {
  approvalRequestId: newId(),
  decision: "approve" as const,
  reason: "nội dung đạt",
  session: { userId: newId(), workspaceId: newId() },
};

function deps(over: Partial<PerformApprovalDeps> = {}): PerformApprovalDeps {
  return {
    loadRequest: async () => ({
      id: base.approvalRequestId,
      workspaceId: base.session.workspaceId,
      campaignId: newId(),
      contentVersionId: newId(),
      targetChannel: "meta_page",
      policyFlags: [],
      evidenceCitationIds: [newId()],
      estimatedImpact: null,
      createdAt: new Date(),
    }),
    isChannelConnected: async () => true,
    saveDecision: vi.fn(async () => undefined),
    writeAudit: vi.fn(async () => undefined),
    ...over,
  };
}

describe("performApproval", () => {
  it("records the decision and writes audit", async () => {
    const d = deps();
    await performApproval(base, d);
    expect(d.saveDecision).toHaveBeenCalledOnce();
    expect(d.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "approval.granted" }));
  });

  it("refuses when the request has no evidence", async () => {
    const d = deps({ loadRequest: async () => ({ ...(await deps().loadRequest(base.approvalRequestId)), evidenceCitationIds: [] }) });
    await expect(performApproval(base, d)).rejects.toThrow(/evidence/i);
    expect(d.saveDecision).not.toHaveBeenCalled();
  });

  it("refuses when the target channel is disconnected", async () => {
    const d = deps({ isChannelConnected: async () => false });
    await expect(performApproval(base, d)).rejects.toThrow(/disconnected|kết nối/i);
    expect(d.saveDecision).not.toHaveBeenCalled();
  });

  it("refuses a request belonging to another workspace", async () => {
    const d = deps({ loadRequest: async () => ({ ...(await deps().loadRequest(base.approvalRequestId)), workspaceId: newId() }) });
    await expect(performApproval(base, d)).rejects.toThrow(/workspace/i);
  });

  it("refuses a blank reason", async () => {
    await expect(performApproval({ ...base, reason: "  " }, deps())).rejects.toThrow(/reason|lý do/i);
  });

  it("adversarial: the recorded decision is always attributed to the session's own user, never a substitutable actor", async () => {
    const d = deps();
    const decision = await performApproval(base, d);
    expect(decision.actorUserId).toBe(base.session.userId);
    // performApproval's input type has no field through which any other
    // actor identity could be named -- `session: { userId, workspaceId }`
    // is the only source, and it always becomes a `{ kind: "user", ... }`
    // Actor (packages/domain/src/approval.ts's decideApproval refuses
    // anything else). There is no agent/system path into this function at
    // all, structurally, not just by convention.
    expect(d.saveDecision).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: base.session.userId }));
  });

  it("adversarial: a reject decision writes a distinct audit event type from approve, never 'approval.granted'", async () => {
    const d = deps();
    await performApproval({ ...base, decision: "reject" }, d);
    expect(d.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "approval.rejected" }));
    expect(d.writeAudit).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: "approval.granted" }));
  });
});
