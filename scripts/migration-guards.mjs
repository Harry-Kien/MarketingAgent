/**
 * Tables that legitimately have no workspace_id. Adding to this list is a
 * reviewed decision (ADR-007), never a convenience.
 */
export const GLOBAL_TABLES = ["workspace", "user_account", "session", "account", "verification", "__drizzle_migrations"];

const CREATE_TABLE = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"?(\w+)"?\s*\(([\s\S]*?)\);/gi;

function tables(sql) {
  const out = [];
  for (const m of sql.matchAll(CREATE_TABLE)) out.push({ name: m[1], body: m[2] });
  return out.filter((t) => !GLOBAL_TABLES.includes(t.name));
}

export function findTenancyViolations(sql) {
  return tables(sql).filter((t) => !/\bworkspace_id\b/.test(t.body)).map((t) => t.name);
}

export function findRlsViolations(sql) {
  return tables(sql)
    .filter((t) => !new RegExp(`ALTER TABLE\\s+"?${t.name}"?\\s+ENABLE ROW LEVEL SECURITY`, "i").test(sql))
    .map((t) => t.name);
}
