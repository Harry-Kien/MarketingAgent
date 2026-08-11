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

/**
 * Split SQL text on semicolons at nesting depth 0, handling unclosed constructs.
 * Resets depth when encountering new CREATE/ALTER statements at depth > 0
 * to recover from malformed statements and prevent cascading failures.
 */
export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  let depth = 0;
  let inString = false;
  let stringChar = null;

  while (i < sql.length) {
    // Check for statement keywords at line boundaries - force split if we're in an unclosed construct
    if (sql[i] === '\n') {
      // Look ahead to see if the next non-whitespace content is a statement keyword
      let j = i + 1;
      while (j < sql.length && /[ \t]/.test(sql[j])) {
        j++;
      }
      const nextChars = sql.substring(j, Math.min(j + 50, sql.length));
      if (/^(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|WITH)\s+/i.test(nextChars)) {
        // If we're in an unclosed construct, treat this as a statement boundary
        if (depth > 0 || inString) {
          current += '\n';
          if (current.trim()) {
            statements.push(current);
          }
          current = '';
          depth = 0;
          inString = false;
          stringChar = null;
          i++;
          continue;
        }
      }
    }

    // Check if we're at the start of a new statement keyword while depth > 0 and not in string
    if (depth > 0 && !inString && /^\s*(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|WITH)\s+/i.test(sql.substring(i))) {
      depth = 0;
    }

    // Single-quoted string
    if (!inString && sql[i] === "'") {
      inString = true;
      stringChar = "'";
      current += sql[i];
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += "''";
          i += 2;
        } else if (sql[i] === "'") {
          current += sql[i];
          inString = false;
          stringChar = null;
          i++;
          break;
        } else if (sql[i] === '\n') {
          // Check if next line starts with CREATE/ALTER - if so, this unterminated string
          // marks the end of the current statement
          current += sql[i];
          let j = i + 1;
          while (j < sql.length && /[ \t]/.test(sql[j])) {
            j++;
          }
          const nextChars = sql.substring(j, Math.min(j + 50, sql.length));
          if (/^(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|WITH)\s+/i.test(nextChars)) {
            // Unterminated string before new statement - force split
            if (current.trim()) {
              statements.push(current);
            }
            current = '';
            depth = 0;
            inString = false;
            stringChar = null;
            i++;
            break;  // Exit string parsing, continue main loop
          } else {
            current += sql[i];
            i++;
          }
        } else {
          current += sql[i];
          i++;
        }
      }
    }
    // Double-quoted identifier
    else if (!inString && sql[i] === '"') {
      inString = true;
      stringChar = '"';
      current += sql[i];
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          current += '""';
          i += 2;
        } else if (sql[i] === '"') {
          current += sql[i];
          inString = false;
          stringChar = null;
          i++;
          break;
        } else {
          current += sql[i];
          i++;
        }
      }
    }
    // Dollar-quoted string
    else if (!inString && sql[i] === '$') {
      let j = i + 1;
      let tag = '';
      while (j < sql.length && (sql[j] === '_' || /\w/.test(sql[j]))) {
        tag += sql[j];
        j++;
      }
      if (j < sql.length && sql[j] === '$') {
        const dollarQuote = '$' + tag + '$';
        inString = true;
        stringChar = dollarQuote;
        current += dollarQuote;
        i = j + 1;
        while (i < sql.length) {
          if (sql.substr(i, dollarQuote.length) === dollarQuote) {
            current += dollarQuote;
            inString = false;
            stringChar = null;
            i += dollarQuote.length;
            break;
          } else {
            current += sql[i];
            i++;
          }
        }
      } else {
        current += sql[i];
        i++;
      }
    }
    // Opening paren (increases depth only when not in string)
    else if (!inString && sql[i] === '(') {
      depth++;
      current += sql[i];
      i++;
    }
    // Closing paren (decreases depth only when not in string)
    else if (!inString && sql[i] === ')') {
      depth--;
      current += sql[i];
      i++;
    }
    // Semicolon at depth 0 (statement boundary, always splits even if inString)
    else if (sql[i] === ';' && depth === 0) {
      current += sql[i];
      if (current.trim()) {
        statements.push(current);
      }
      current = '';
      inString = false;  // Reset in case of unclosed string
      stringChar = null;
      i++;
    }
    else {
      current += sql[i];
      i++;
    }
  }

  // Add any remaining statement
  if (current.trim()) {
    statements.push(current);
  }

  return statements;
}

/**
 * Extract table definitions from SQL statements. Parses each statement
 * individually to find CREATE TABLE declarations with their column definitions.
 */
function tables(sql) {
  const statements = splitStatements(stripComments(sql));
  const out = [];

  for (const stmt of statements) {
    // Match CREATE TABLE [IF NOT EXISTS] [schema.]name ( - allow leading whitespace
    const match = stmt.match(/^\s*CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"?(?:\w+)\."?)?(?:"?(\w+)"?)\s*\(/i);
    if (match) {
      const tableName = match[1];
      // Extract everything from opening paren to end of statement
      const parenStart = stmt.indexOf('(');
      if (parenStart !== -1) {
        const body = stmt.substring(parenStart + 1);
        out.push({ name: tableName, body });
      }
    }
  }

  return out.filter((t) => !GLOBAL_TABLES.includes(t.name));
}

export function findTenancyViolations(sql) {
  return tables(sql).filter((t) => !/\bworkspace_id\b/.test(t.body)).map((t) => t.name);
}

export function findRlsViolations(sql) {
  const statements = splitStatements(stripComments(sql));
  const tablesFound = tables(sql);
  const rlsEnabledTables = new Set();

  for (const stmt of statements) {
    const rlsMatch = stmt.match(/ALTER\s+TABLE\s+(?:"?(?:\w+)\."?)?(?:"?(\w+)"?)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    if (rlsMatch) {
      rlsEnabledTables.add(rlsMatch[1]);
    }
  }

  return tablesFound.filter((t) => !rlsEnabledTables.has(t.name)).map((t) => t.name);
}
