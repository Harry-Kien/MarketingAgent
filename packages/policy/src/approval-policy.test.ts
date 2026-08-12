import { describe, expect, it } from "vitest";
import { evaluateGate, trustActionKind } from "./approval-policy.ts";
import { classifyRisk, type RiskLevel } from "./risk.ts";

// Fix round 1: GateInput.actionKind is now TrustedActionKind, constructible
// only via trustActionKind() against a real allowlist. Every evaluateGate
// call below self-allowlists the single kind it needs -- these tests are
// about risk classification and gating, not about allowlist plumbing, so
// each kind is trivially "on the allowlist" by naming only itself.
const kind = (k: string) => trustActionKind(k, [k]);

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

  // Fix round 1, CRITICAL, reproduction: ACTION_RISK is (was) a plain object
  // literal, so these eight names resolve through Object.prototype instead
  // of failing the lookup. Each must classify as "medium" (fail closed),
  // exactly like any other unrecognised kind -- one test per name, not a
  // loop, so a single regression cannot hide behind eight silently-skipped
  // iterations.
  it("does not resolve __proto__ through the prototype chain", () => {
    expect(classifyRisk({ kind: "__proto__", text: "" })).toBe("medium");
  });
  it("does not resolve constructor through the prototype chain", () => {
    expect(classifyRisk({ kind: "constructor", text: "" })).toBe("medium");
  });
  it("does not resolve toString through the prototype chain", () => {
    expect(classifyRisk({ kind: "toString", text: "" })).toBe("medium");
  });
  it("does not resolve hasOwnProperty through the prototype chain", () => {
    expect(classifyRisk({ kind: "hasOwnProperty", text: "" })).toBe("medium");
  });
  it("does not resolve valueOf through the prototype chain", () => {
    expect(classifyRisk({ kind: "valueOf", text: "" })).toBe("medium");
  });
  it("does not resolve isPrototypeOf through the prototype chain", () => {
    expect(classifyRisk({ kind: "isPrototypeOf", text: "" })).toBe("medium");
  });
  it("does not resolve propertyIsEnumerable through the prototype chain", () => {
    expect(classifyRisk({ kind: "propertyIsEnumerable", text: "" })).toBe("medium");
  });
  it("does not resolve toLocaleString through the prototype chain", () => {
    expect(classifyRisk({ kind: "toLocaleString", text: "" })).toBe("medium");
  });

  // Fix round 1, IMPORTANT, reproduction: a non-string kind must be refused
  // outright, never coerced (ToPropertyKey) into a lookup key -- a malicious
  // toString() must not be able to choose its own classification.
  it("rejects a non-string kind (object with malicious toString)", () => {
    const malicious = { toString: () => "read_analytics" };
    expect(() => classifyRisk({ kind: malicious as unknown as string, text: "" })).toThrow(TypeError);
  });
  it("rejects a numeric kind", () => {
    expect(() => classifyRisk({ kind: 42 as unknown as string, text: "" })).toThrow(TypeError);
  });
  it("rejects a symbol kind", () => {
    expect(() => classifyRisk({ kind: Symbol("x") as unknown as string, text: "" })).toThrow(TypeError);
  });
  it("rejects an array kind", () => {
    expect(() => classifyRisk({ kind: ["publish_social"] as unknown as string, text: "" })).toThrow(TypeError);
  });

  // Every legitimate kind must still classify exactly as before the fix --
  // the lookup mechanism changed, the data and the results must not have.
  const EXPECTED_RISK: Record<string, RiskLevel> = {
    read_analytics: "none",
    create_research: "low",
    create_draft: "low",
    suggest_optimisation: "low",
    edit_brand_brain: "medium",
    publish_social: "high",
    send_bulk_email: "high",
    reply_public: "high",
    change_ad_budget: "critical",
    delete_data: "critical",
    export_pii: "critical",
    crisis_response: "critical",
  };
  for (const [actionKind, expected] of Object.entries(EXPECTED_RISK)) {
    it(`still classifies "${actionKind}" as ${expected} (unchanged by the fix)`, () => {
      expect(classifyRisk({ kind: actionKind, text: "" })).toBe(expected);
    });
  }
});

describe("evaluateGate", () => {
  it("requires approval for any publish", () => {
    const d = evaluateGate({ actionKind: kind("publish_social"), text: "ok", qaVerdict: "pass" });
    expect(d.gate).toBe("approval");
  });

  it("still requires approval when QA passed — quality never grants permission", () => {
    const pass = evaluateGate({ actionKind: kind("publish_social"), text: "ok", qaVerdict: "pass" });
    const block = evaluateGate({ actionKind: kind("publish_social"), text: "ok", qaVerdict: "block" });
    expect(pass.gate).toBe("approval");
    expect(block.gate).toBe("approval");
  });

  it("escalates sensitive content", () => {
    const d = evaluateGate({
      actionKind: kind("publish_social"),
      text: "tư vấn pháp lý và hoàn tiền",
      qaVerdict: "pass",
    });
    expect(d.escalate).toBe(true);
  });

  it("needs no gate for a draft with ordinary content", () => {
    expect(
      evaluateGate({ actionKind: kind("create_draft"), text: "bài viết thường", qaVerdict: "pass" }).gate,
    ).toBe("none");
  });

  it("always reports a versioned rule id", () => {
    const d = evaluateGate({ actionKind: kind("publish_social"), text: "x", qaVerdict: "pass" });
    expect(d.ruleId).toMatch(/^POLICY-/);
    expect(d.ruleVersion).toBeGreaterThan(0);
  });

  // Adversarial: an unrecognised action kind must gate by default (fails
  // closed), so a tool added without updating the risk table cannot slip
  // past the founder unreviewed.
  it("gates an unrecognised action kind by default", () => {
    expect(
      evaluateGate({ actionKind: kind("some_future_action_kind"), text: "", qaVerdict: "pass" }).gate,
    ).toBe("approval");
  });

  // Adversarial: qaVerdict is provenance only. A "block" verdict on an
  // already-ungated low-risk draft must not itself invent a gate --
  // qaVerdict must never be read as an input to the gate condition at all.
  it("qaVerdict never adds a gate that risk alone did not require", () => {
    expect(
      evaluateGate({ actionKind: kind("create_draft"), text: "bài viết thường", qaVerdict: "block" }).gate,
    ).toBe("none");
  });

  // Fix round 1, CRITICAL, reproduction at the evaluateGate layer (not just
  // classifyRisk): each of the eight Object.prototype names must still gate
  // as an unrecognised kind, never resolve to "none" through the prototype
  // chain. One test per name, not a loop.
  it("gates __proto__ as actionKind, never resolves it via the prototype chain", () => {
    expect(evaluateGate({ actionKind: kind("__proto__"), text: "", qaVerdict: "pass" }).gate).toBe("approval");
  });
  it("gates constructor as actionKind, never resolves it via the prototype chain", () => {
    expect(evaluateGate({ actionKind: kind("constructor"), text: "", qaVerdict: "pass" }).gate).toBe("approval");
  });
  it("gates toString as actionKind, never resolves it via the prototype chain", () => {
    expect(evaluateGate({ actionKind: kind("toString"), text: "", qaVerdict: "pass" }).gate).toBe("approval");
  });
  it("gates hasOwnProperty as actionKind, never resolves it via the prototype chain", () => {
    expect(evaluateGate({ actionKind: kind("hasOwnProperty"), text: "", qaVerdict: "pass" }).gate).toBe("approval");
  });
  it("gates valueOf as actionKind, never resolves it via the prototype chain", () => {
    expect(evaluateGate({ actionKind: kind("valueOf"), text: "", qaVerdict: "pass" }).gate).toBe("approval");
  });
  it("gates isPrototypeOf as actionKind, never resolves it via the prototype chain", () => {
    expect(evaluateGate({ actionKind: kind("isPrototypeOf"), text: "", qaVerdict: "pass" }).gate).toBe("approval");
  });
  it("gates propertyIsEnumerable as actionKind, never resolves it via the prototype chain", () => {
    expect(evaluateGate({ actionKind: kind("propertyIsEnumerable"), text: "", qaVerdict: "pass" }).gate).toBe(
      "approval",
    );
  });
  it("gates toLocaleString as actionKind, never resolves it via the prototype chain", () => {
    expect(evaluateGate({ actionKind: kind("toLocaleString"), text: "", qaVerdict: "pass" }).gate).toBe("approval");
  });
});

describe("trustActionKind", () => {
  it("accepts a name that is literally on the allowlist", () => {
    expect(() => trustActionKind("publish_social", ["publish_social", "create_draft"])).not.toThrow();
  });

  it("rejects a name that is not on the allowlist", () => {
    // The exact wiring risk this brand exists to close: a name that was
    // never vetted against the caller's real tool allowlist must not become
    // a TrustedActionKind just because it looks plausible.
    expect(() => trustActionKind("publish_social", ["create_draft"])).toThrow();
  });

  it("rejects a non-string name outright rather than coercing it", () => {
    const malicious = { toString: () => "create_draft" };
    expect(() => trustActionKind(malicious as unknown as string, ["create_draft"])).toThrow(TypeError);
  });

  it("treats an Object.prototype-named allowlist entry as an ordinary string, nothing implicit", () => {
    // The allowlist itself is an ordinary array (indexOf/includes), not an
    // object-literal lookup, so it never had the CRITICAL bug -- this just
    // pins that guarantee for the one other place a "kind" name is checked
    // against a collection in this package.
    expect(() => trustActionKind("__proto__", ["publish_social"])).toThrow();
    expect(() => trustActionKind("__proto__", ["__proto__"])).not.toThrow();
  });
});
