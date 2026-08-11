/**
 * Tables that legitimately have no workspace_id. Adding to this list is a
 * reviewed decision (ADR-007), never a convenience.
 */
export const GLOBAL_TABLES = ["workspace", "user_account", "session", "account", "verification", "__drizzle_migrations"];

/**
 * Strip SQL comments (line comments and block comments) to prevent
 * commented-out security requirements from bypassing guards.
 */
function stripComments(sql) {
  // Remove block comments /* ... */
  let result = sql.replace(/\/\*[\s\S]*?\*\//g, "");
  // Remove line comments --
  result = result.replace(/--[^\n]*$/gm, "");
  return result;
}

// Matches schema-qualified or unqualified table names
const CREATE_TABLE = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(?:"?(?:\w+)\."?)?(?:"?(\w+)"?)\s*\(([\s\S]*?)\);/gi;

function tables(sql) {
  const stripped = stripComments(sql);
  const out = [];
  for (const m of stripped.matchAll(CREATE_TABLE)) out.push({ name: m[1], body: m[2] });
  return out.filter((t) => !GLOBAL_TABLES.includes(t.name));
}

export function findTenancyViolations(sql) {
  return tables(sql).filter((t) => !/\bworkspace_id\b/.test(t.body)).map((t) => t.name);
}

export function findRlsViolations(sql) {
  const stripped = stripComments(sql);
  return tables(sql)
    .filter((t) => !new RegExp(`ALTER TABLE\\s+(?:"?(?:\\w+)\\."?)?(?:"?${t.name}"?)\\s+ENABLE ROW LEVEL SECURITY`, "i").test(stripped))
    .map((t) => t.name);
}
