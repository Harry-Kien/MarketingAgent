import { describe, expect, it } from "vitest";
import { evaluateGate } from "./approval-policy.ts";
import { classifyRisk } from "./risk.ts";

describe("classifyRisk", () => {
  it("marks publishing as high risk", () => {
    expect(classifyRisk({ kind: "publish_social", text: "bài đăng" })).toBe("high");
  });
  it("marks a budget change as critical", () => {
    expect(classifyRisk({ kind: "change_ad_budget", text: "" })).toBe("critical");
  });
  it("marks reading as no risk", () => {
    expect(classifyRisk({ kind: "read_analytics", text: "" })).toBe("none");
  });
  it("escalates on sensitive Vietnamese content regardless of action kind", () => {
    expect(classifyRisk({ kind: "create_draft", text: "khiếu nại về dữ liệu cá nhân" })).toBe("critical");
  });

  // Adversarial: agent output (`text`) is untrusted. It must only ever be
  // able to push a classification UP toward more scrutiny, never down. An
  // agent that fills a publish action with cheerful, ordinary-looking text
  // must not talk its way out of the "high" risk that action kind carries.
  it("ordinary-looking text cannot downgrade a high-risk action kind", () => {
    expect(
      classifyRisk({ kind: "publish_social", text: "hoàn toàn bình thường, không có gì đặc biệt" }),
    ).toBe("high");
  });

  it("ordinary-looking text cannot downgrade a critical action kind", () => {
    expect(classifyRisk({ kind: "change_ad_budget", text: "just a routine update" })).toBe("critical");
  });

  // Fail closed: an action kind this table has never seen must not default
  // to "no approval needed" -- an unrecognised kind requires more scrutiny,
  // not less, so a new/renamed tool cannot accidentally skip the gate before
  // someone adds it to ACTION_RISK.
  it("defaults an unknown action kind to medium, not none", () => {
    expect(classifyRisk({ kind: "some_future_action_kind", text: "" })).toBe("medium");
  });
});

describe("evaluateGate", () => {
  it("requires approval for any publish", () => {
    const d = evaluateGate({ actionKind: "publish_social", text: "ok", qaVerdict: "pass" });
    expect(d.gate).toBe("approval");
  });

  it("still requires approval when QA passed — quality never grants permission", () => {
    const pass = evaluateGate({ actionKind: "publish_social", text: "ok", qaVerdict: "pass" });
    const block = evaluateGate({ actionKind: "publish_social", text: "ok", qaVerdict: "block" });
    expect(pass.gate).toBe("approval");
    expect(block.gate).toBe("approval");
  });

  it("escalates sensitive content", () => {
    const d = evaluateGate({ actionKind: "publish_social", text: "tư vấn pháp lý và hoàn tiền", qaVerdict: "pass" });
    expect(d.escalate).toBe(true);
  });

  it("needs no gate for a draft with ordinary content", () => {
    expect(evaluateGate({ actionKind: "create_draft", text: "bài viết thường", qaVerdict: "pass" }).gate).toBe("none");
  });

  it("always reports a versioned rule id", () => {
    const d = evaluateGate({ actionKind: "publish_social", text: "x", qaVerdict: "pass" });
    expect(d.ruleId).toMatch(/^POLICY-/);
    expect(d.ruleVersion).toBeGreaterThan(0);
  });

  // Adversarial: an unrecognised action kind must gate by default (fails
  // closed), so a tool added without updating the risk table cannot slip
  // past the founder unreviewed.
  it("gates an unrecognised action kind by default", () => {
    expect(
      evaluateGate({ actionKind: "some_future_action_kind", text: "", qaVerdict: "pass" }).gate,
    ).toBe("approval");
  });

  // Adversarial: qaVerdict is provenance only. A "block" verdict on an
  // already-ungated low-risk draft must not itself invent a gate --
  // qaVerdict must never be read as an input to the gate condition at all.
  it("qaVerdict never adds a gate that risk alone did not require", () => {
    expect(
      evaluateGate({ actionKind: "create_draft", text: "bài viết thường", qaVerdict: "block" }).gate,
    ).toBe("none");
  });
});
