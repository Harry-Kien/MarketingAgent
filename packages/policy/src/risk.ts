// T8: risk classification. This is deliberately a pure lookup + one escalation
// rule, not a model call and not a heuristic the model can talk its way
// around: `action.text` is read only to ESCALATE risk upward, never to lower
// it. If a caller ever lets a model choose `action.kind` freely (rather than
// deriving it from the tool/action actually invoked, per the construction-time
// allowlist in packages/agents/src/tools.ts), that caller reintroduces a
// bypass this function cannot see -- classifyRisk trusts `kind` as given.
export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

// Fix round 1, CRITICAL: this table used to be a plain `Record<string,
// RiskLevel>` object literal (`{}`), which inherits from Object.prototype.
// For `kind` in "__proto__", "constructor", "toString", "hasOwnProperty",
// "valueOf", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString",
// `ACTION_RISK[kind]` resolved to an INHERITED Object.prototype value
// instead of `undefined` -- `?? "medium"` never fired, because the lookup
// never actually missed. A caller could pass `actionKind: "__proto__"` and
// switch the approval gate off with a plain string, no type escape and no
// unusual call. Fixed with a Map: a Map's entries live in its own internal
// table, never on a prototype chain, so there is no set of inherited names
// left to collide with, and `.get()` returns `undefined` for a genuinely
// missing key by construction -- not by an `Object.hasOwn` check that the
// next call site could forget to add. (`Object.create(null)` would also
// have worked, but a Map keeps the "no inherited properties" guarantee
// local to the data structure itself, rather than depending on every future
// reader remembering why this particular object has no prototype.)
const ACTION_RISK: ReadonlyMap<string, RiskLevel> = new Map([
  ["read_analytics", "none"],
  ["create_research", "low"],
  ["create_draft", "low"],
  ["suggest_optimisation", "low"],
  ["edit_brand_brain", "medium"],
  ["publish_social", "high"],
  ["send_bulk_email", "high"],
  ["reply_public", "high"],
  ["change_ad_budget", "critical"],
  ["delete_data", "critical"],
  ["export_pii", "critical"],
  ["crisis_response", "critical"],
]);
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
  // Fix round 1, IMPORTANT: reject a non-string kind outright instead of
  // letting JavaScript coerce it. `Map.get` does not itself coerce its
  // argument (unlike `obj[key]`'s ToPropertyKey), so an object key would
  // simply miss -- but trusting that silently would still let a malformed
  // caller pass `{ toString() { return "read_analytics"; } }` through a
  // *different* code path (e.g. a future `String(action.kind)` normalising
  // step) and have it resolve to a real, low-severity entry. Refusing a
  // non-string at the door, the same way `createGateway`
  // (packages/model-gateway/src/gateway.ts) refuses a non-finite
  // `estimatedCostUsd` before ever comparing against it, removes the
  // question entirely rather than relying on Map's incidental safety.
  if (typeof action.kind !== "string") {
    throw new TypeError(
      `classifyRisk requires action.kind to be a string; got ${typeof action.kind}. A non-string ` +
        `value must never be coerced into a risk-table lookup key.`,
    );
  }
  if (SENSITIVE.test(action.text)) return "critical";
  return ACTION_RISK.get(action.kind) ?? "medium";
}
