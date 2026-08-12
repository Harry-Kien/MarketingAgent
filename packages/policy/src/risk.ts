// T8: risk classification. This is deliberately a pure lookup + one escalation
// rule, not a model call and not a heuristic the model can talk its way
// around: `action.text` is read only to ESCALATE risk upward, never to lower
// it. If a caller ever lets a model choose `action.kind` freely (rather than
// deriving it from the tool/action actually invoked, per the construction-time
// allowlist in packages/agents/src/tools.ts), that caller reintroduces a
// bypass this function cannot see -- classifyRisk trusts `kind` as given.
export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

const ACTION_RISK: Record<string, RiskLevel> = {
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
// No publish_journey entry: Journey does not exist in M1 and must not have a
// reserved slot anywhere (invariant 8). Unknown action kinds already default
// to "medium", which requires approval -- so adding it later is safe by
// default, and a typo in `kind` fails closed rather than open.

/**
 * Sensitive topics escalate no matter what the action is. Kept as an
 * explicit, versioned list rather than a hard-coded regex buried in workflow
 * code. `text` is agent/model output -- untrusted content -- so this pattern
 * is used only to RAISE the result the action-kind table already produced,
 * never to lower it: the worst an attacker can do by stuffing or omitting
 * these words is push their own action toward more scrutiny, never less.
 */
const SENSITIVE =
  /(pháp lý|dữ liệu cá nhân|sức khoẻ|sức khỏe|tài chính|khiếu nại|khủng hoảng|thù ghét|hoàn tiền|chi tiền)/i;

export function classifyRisk(action: { kind: string; text: string }): RiskLevel {
  if (SENSITIVE.test(action.text)) return "critical";
  return ACTION_RISK[action.kind] ?? "medium";
}
