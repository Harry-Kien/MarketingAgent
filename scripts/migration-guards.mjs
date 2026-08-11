/**
 * Tables that legitimately have no workspace_id. Adding to this list is a
 * reviewed decision (ADR-007), never a convenience.
 */
export const GLOBAL_TABLES = ["workspace", "user_account", "session", "account", "verification", "__drizzle_migrations"];

/**
 * Strip SQL comments (line and block) while respecting string literals and
 * dollar-quoted blocks. State machine walks character-by-character to properly
 * handle: single quotes with '' escaping, double-quoted identifiers, dollar-quoted
 * strings ($tag$...$tag$), and only strips comments outside all of these contexts.
 */
export function stripComments(sql) {
  let result = '';
  let i = 0;
  while (i < sql.length) {
    // Single-quoted string: 'string with ''escaped'' quotes'
    if (sql[i] === "'") {
      result += sql[i];
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          result += "''";
          i += 2;
        } else if (sql[i] === "'") {
          result += sql[i];
          i++;
          break;
        } else {
          result += sql[i];
          i++;
        }
      }
    }
    // Double-quoted identifier: "column_name"
    else if (sql[i] === '"') {
      result += sql[i];
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          result += '""';
          i += 2;
        } else if (sql[i] === '"') {
          result += sql[i];
          i++;
          break;
        } else {
          result += sql[i];
          i++;
        }
      }
    }
    // Dollar-quoted string: $$...$$  or  $tag$...$tag$
    else if (sql[i] === '$') {
      let j = i + 1;
      let tag = '';
      while (j < sql.length && (sql[j] === '_' || /\w/.test(sql[j]))) {
        tag += sql[j];
        j++;
      }
      if (j < sql.length && sql[j] === '$') {
        const dollarQuote = '$' + tag + '$';
        result += dollarQuote;
        i = j + 1;
        while (i < sql.length) {
          if (sql.substr(i, dollarQuote.length) === dollarQuote) {
            result += dollarQuote;
            i += dollarQuote.length;
            break;
          } else {
            result += sql[i];
            i++;
          }
        }
      } else {
        result += sql[i];
        i++;
      }
    }
    // Block comment: /* ... */
    else if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          i += 2;
          break;
        }
        i++;
      }
    }
    // Line comment: -- to end of line
    else if (sql[i] === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') {
        i++;
      }
      if (i < sql.length && sql[i] === '\n') {
        result += '\n';
        i++;
      }
    }
    // Normal character
    else {
      result += sql[i];
      i++;
    }
  }
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
