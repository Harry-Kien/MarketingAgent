/**
 * Invariant 4 (the sharp one, per STANDING-CONTEXT): quality_score is
 * evidence for a human, never authorization. A score must never be able to
 * substitute for a recorded ApprovalDecision anywhere in this codebase --
 * not in TypeScript, not in SQL. We look for it inside a comparison, which
 * is the shape permission logic takes (an `if`, a ternary, a SQL WHERE/CASE,
 * a boolean assignment feeding a later gate) -- deriving ANY boolean signal
 * directly from the raw score is the violation, regardless of what the
 * resulting boolean is later named or used for.
 *
 * Matches both camelCase (`qualityScore`) and the database's snake_case
 * (`quality_score`), on either side of the comparison operator, so
 * `qualityScore >= 80` and `80 <= quality_score` are both caught. This is a
 * lexical/regex guard, the same style as this repo's other purity guards
 * (domain-purity.mjs, migration-guards.mjs) -- it catches the score used
 * directly in a comparison; it does not trace data flow through a renamed
 * intermediate variable (`const qs = x.qualityScore; if (qs >= 80) ...`)
 * or a SQL column alias. That is a known, accepted limitation shared with
 * every other lexical guard in this repo, not unique to this one.
 */
const COMPARISON = /(quality[_]?[sS]core)\s*(>=|<=|>|<|===|!==|==|!=)\s*[\w.'"]+/g;
const REVERSE = /[\w.'"]+\s*(>=|<=|>|<|===|!==|==|!=)\s*(quality[_]?[sS]core)/g;

export function findQualityScoreAuthz(source) {
  const hits = [];
  for (const m of source.matchAll(COMPARISON)) hits.push(m[0]);
  for (const m of source.matchAll(REVERSE)) hits.push(m[0]);
  return hits;
}
