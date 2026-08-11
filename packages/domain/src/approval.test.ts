import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import { assertRenderable, decideApproval, type ApprovalRequest } from "./approval.ts";
import { ApprovalIntegrityError } from "./errors.ts";
import type { Actor } from "./actor.ts";

const user: Actor = { kind: "user", userId: newId() };
const agent: Actor = { kind: "agent", agentRunId: newId(), agentVersionId: newId() };
const system: Actor = { kind: "system", reason: "scheduler" };

const req = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: newId(), workspaceId: newId(), campaignId: newId(), contentVersionId: newId(),
  targetChannel: "meta_page", policyFlags: [], evidenceCitationIds: [newId()],
  estimatedImpact: "reach ~1.200", createdAt: new Date(), ...over,
});

describe("assertRenderable", () => {
  it("passes for a complete request", () => { expect(() => assertRenderable(req())).not.toThrow(); });
  it("refuses a request with no evidence", () => {
    expect(() => assertRenderable(req({ evidenceCitationIds: [] }))).toThrow(/evidence/i);
  });
  it("refuses a request with no target channel", () => {
    expect(() => assertRenderable(req({ targetChannel: "" }))).toThrow(/channel/i);
  });
});

describe("decideApproval", () => {
  it("records a user decision", () => {
    const d = decideApproval(req(), { actor: user, decision: "approve", reason: "nội dung đạt" });
    expect(d.decision).toBe("approve");
    expect(d.actorUserId).toBe(user.userId);
  });
  it("refuses an agent actor", () => {
    expect(() => decideApproval(req(), { actor: agent, decision: "approve", reason: "x" }))
      .toThrow(ApprovalIntegrityError);
  });
  it("refuses a system actor", () => {
    expect(() => decideApproval(req(), { actor: system, decision: "approve", reason: "x" }))
      .toThrow(ApprovalIntegrityError);
  });
  it("refuses a blank reason on reject", () => {
    expect(() => decideApproval(req(), { actor: user, decision: "reject", reason: " " })).toThrow(/reason/i);
  });
});
