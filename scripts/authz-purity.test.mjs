import { describe, expect, it } from "vitest";
import { findQualityScoreAuthz } from "./authz-purity.mjs";

describe("findQualityScoreAuthz", () => {
  it("flags quality_score used in a permission condition", () => {
    const src = `if (qualityScore >= 80) { return allowPublish(); }`;
    expect(findQualityScoreAuthz(src)).toHaveLength(1);
  });
  it("flags snake_case in SQL permission logic", () => {
    const src = `where quality_score > 70 and state = 'APPROVED'`;
    expect(findQualityScoreAuthz(src)).toHaveLength(1);
  });
  it("allows quality score as a plain data field", () => {
    const src = `const out = { qualityScore: 90 }; return out;`;
    expect(findQualityScoreAuthz(src)).toEqual([]);
  });
  it("allows it inside a test file assertion", () => {
    const src = `expect(result.qualityScore).toBe(90);`;
    expect(findQualityScoreAuthz(src)).toEqual([]);
  });

  // Adversarial additions (self-review: "make a high quality_score stand in
  // for an approval"). Not weakening any assertion above -- these are new
  // cases proving the guard has real teeth beyond the brief's four literal
  // examples, and that it does not simply refuse everything.

  it("flags the reversed comparison order (literal on the left)", () => {
    const src = `if (80 <= qualityScore) { return allowPublish(); }`;
    expect(findQualityScoreAuthz(src)).toHaveLength(1);
  });

  it("flags a ternary that derives approval state directly from the score", () => {
    const src = `const state = qualityScore >= 80 ? 'APPROVED' : 'WAITING_APPROVAL';`;
    expect(findQualityScoreAuthz(src)).toHaveLength(1);
  });

  it("flags a SQL UPDATE that gates the approval state on quality_score", () => {
    const src = `UPDATE approval_request SET state='APPROVED' WHERE quality_score>=80`;
    expect(findQualityScoreAuthz(src)).toHaveLength(1);
  });

  it("flags a strict-equality short-circuit used as a gate", () => {
    const src = `return qualityScore === 100 && publish();`;
    expect(findQualityScoreAuthz(src)).toHaveLength(1);
  });

  it("allows a quality score simply being persisted or logged", () => {
    const src = `await store.recordFinding({ severity: "info", qualityScore, message: "fyi" });\nlogger.info("qa result", { qualityScore });`;
    expect(findQualityScoreAuthz(src)).toEqual([]);
  });

  it("allows a real ApprovalDecision-based gate that never mentions quality_score at all", () => {
    const src = `if (actor.kind === "user" && campaign.state === "WAITING_APPROVAL") { return decideApproval(campaign, actor, decision); }`;
    expect(findQualityScoreAuthz(src)).toEqual([]);
  });
});
