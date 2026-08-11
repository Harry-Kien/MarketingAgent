/**
 * Tables that legitimately have no workspace_id. Adding to this list is a
 * reviewed decision (ADR-007), never a convenience.
 *
 * `schema_migration` is created procedurally by scripts/apply-migrations.mjs
 * (CREATE TABLE IF NOT EXISTS, run outside any tracked migration file) to
 * record which migrations have been applied. It holds no tenant data and is
 * legitimately global, but never appears in a migration file, so
 * check-migrations.mjs never sees it to classify it either way -- it is
 * listed here purely so this allowlist tells the truth about what tables
 * actually exist (see packages/db/src/cross-tenant.test.ts's GLOBAL_TABLES
 * cross-check, task-12-report.md).
 */
export const GLOBAL_TABLES = [
  "workspace", "user_account", "session", "account", "verification",
  "__drizzle_migrations", "schema_migration",
];

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
 * Split SQL text on semicolons at nesting depth 0. String-, quoted-identifier-,
 * and dollar-quote-aware, so a `;` inside any of those never splits a
 * statement. Does NOT attempt to recover from unclosed constructs — round 3's
 * newline+keyword lookahead heuristic that tried to guess a statement
 * boundary inside an unterminated string/paren was removed in round 5 (it is
 * the anti-pattern the fail-closed `parseFile`/`collectFileFacts` pipeline
 * exists to replace; see the module header comment). On malformed input this
 * simply yields whatever partial text accumulated as a final degenerate
 * "statement" — callers that need fail-closed guarantees must use
 * `parseFile`/`collectFileFacts`, not this function.
 */
export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  let depth = 0;
  let inString = false;

  while (i < sql.length) {
    // Single-quoted string
    if (!inString && sql[i] === "'") {
      inString = true;
      current += sql[i];
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += "''";
          i += 2;
        } else if (sql[i] === "'") {
          current += sql[i];
          inString = false;
          i++;
          break;
        } else {
          current += sql[i];
          i++;
        }
      }
    }
    // Double-quoted identifier
    else if (!inString && sql[i] === '"') {
      inString = true;
      current += sql[i];
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          current += '""';
          i += 2;
        } else if (sql[i] === '"') {
          current += sql[i];
          inString = false;
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
        current += dollarQuote;
        i = j + 1;
        while (i < sql.length) {
          if (sql.substr(i, dollarQuote.length) === dollarQuote) {
            current += dollarQuote;
            inString = false;
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
    // Semicolon at depth 0 (statement boundary)
    else if (sql[i] === ';' && depth === 0) {
      current += sql[i];
      if (current.trim()) {
        statements.push(current);
      }
      current = '';
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

/* =============================================================================
 * Per-file, fail-closed parsing (rounds 4-5).
 *
 * `stripComments`, `findTenancyViolations`, `findRlsViolations` above are
 * UNCHANGED from round 3 and kept only so the original 24-test suite (minus
 * the two tests retired in round 5 that pinned the removed heuristic — see
 * the round-5 report section) keeps passing. `check-migrations.mjs` (the
 * actual CI gate) does not call any of them. `splitStatements` above HAS
 * changed in round 5: the newline+keyword lookahead recovery heuristic was
 * deleted (it was never load-bearing for the gate, only for the two retired
 * tests) — it now just splits correctly on well-formed input and degrades
 * to a single trailing partial statement on malformed input, with no
 * guessing.
 *
 * The functions below are the real guard. Rules that make it structurally
 * different from everything above:
 *
 *   1. `parseFile` is called once per migration file. It is never given text
 *      from more than one file, so a malformed file can never corrupt the
 *      parse of any other file — there is no "joined blob" for a bug to hide
 *      in.
 *   2. `parseFile` never guesses. If it reaches end-of-input still inside a
 *      string, a dollar-quoted block, a block comment, or with unbalanced
 *      parentheses, it stops and reports exactly what was left open. It also
 *      never lets its paren-depth counter go negative: a stray ')' with no
 *      matching '(' fails the file the instant it is seen, rather than
 *      letting a later unrelated '(' net the count back to zero and launder
 *      the structural error (round 5, CRITICAL).
 *   3. `collectFileFacts` extracts a CREATE TABLE's column body as the EXACT
 *      span between its opening '(' and the matching ')' (`findMatchingParen`,
 *      string/dollar-quote aware), never "everything from the opening paren
 *      to the end of the statement." Text after the real close cannot
 *      satisfy the `workspace_id` check just by containing that word
 *      (round 5, CRITICAL). If the matching ')' cannot be found, the file
 *      fails closed.
 *   4. Cross-file aggregation (`computeViolations`) operates on plain data —
 *      arrays of {name, hasWorkspaceId} and lists of RLS-enabled table names
 *      — never on concatenated SQL text.
 * ============================================================================= */

/**
 * Parse a single migration file's raw SQL into top-level statements, stripping
 * comments and splitting on `;` at paren depth 0. Fails closed: if the file
 * ends while still inside a string, quoted identifier, dollar-quoted block,
 * block comment, or with unbalanced parentheses, parsing stops immediately
 * and `unterminated` describes exactly what was left open. No statements are
 * guessed or recovered past that point — the caller must treat the whole
 * file as uncertifiable.
 */
export function parseFile(sql) {
  const statements = [];
  let current = "";
  let depth = 0;
  let i = 0;
  const n = sql.length;
  let unterminated = null;

  outer: while (i < n) {
    const ch = sql[i];

    // Single-quoted string literal: 'text with ''escaped'' quotes'
    if (ch === "'") {
      current += ch;
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += "''";
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          current += sql[i];
          i++;
          closed = true;
          break;
        }
        current += sql[i];
        i++;
      }
      if (!closed) {
        unterminated = { construct: "unterminated string literal (')" };
        break outer;
      }
      continue;
    }

    // Double-quoted identifier: "name with ""escaped"" quotes"
    if (ch === '"') {
      current += ch;
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          current += '""';
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          current += sql[i];
          i++;
          closed = true;
          break;
        }
        current += sql[i];
        i++;
      }
      if (!closed) {
        unterminated = { construct: 'unterminated quoted identifier (")' };
        break outer;
      }
      continue;
    }

    // Dollar-quoted block: $$...$$ or $tag$...$tag$
    if (ch === "$") {
      let j = i + 1;
      let tag = "";
      while (j < n && /\w/.test(sql[j])) {
        tag += sql[j];
        j++;
      }
      if (sql[j] === "$") {
        const dollarQuote = `$${tag}$`;
        current += dollarQuote;
        i = j + 1;
        let closed = false;
        while (i < n) {
          if (sql.startsWith(dollarQuote, i)) {
            current += dollarQuote;
            i += dollarQuote.length;
            closed = true;
            break;
          }
          current += sql[i];
          i++;
        }
        if (!closed) {
          unterminated = { construct: `unterminated dollar-quoted block (${dollarQuote})` };
          break outer;
        }
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    // Block comment: /* ... */ (stripped; a single space avoids merging adjacent tokens)
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      let closed = false;
      while (i < n) {
        if (sql[i] === "*" && sql[i + 1] === "/") {
          i += 2;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) {
        unterminated = { construct: "unterminated block comment (/* */)" };
        break outer;
      }
      current += " ";
      continue;
    }

    // Line comment: -- to end of line (stripped; the newline itself is preserved)
    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }

    if (ch === "(") {
      depth++;
      current += ch;
      i++;
      continue;
    }
    if (ch === ")") {
      // A close paren with no open to match is malformed input the instant it
      // happens — depth must never go negative. Netting back to zero via a
      // later, unrelated '(' would launder a structural error and desync
      // every statement/body boundary computed after this point (round 5,
      // CRITICAL: reviewer-constructed PoC). Fail this file closed here,
      // rather than only detecting an imbalance at EOF.
      if (depth === 0) {
        unterminated = { construct: "unbalanced parentheses (unexpected ')' with no matching '(')" };
        break outer;
      }
      depth--;
      current += ch;
      i++;
      continue;
    }

    if (ch === ";" && depth === 0) {
      current += ch;
      if (current.trim()) statements.push(current);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (!unterminated) {
    if (depth !== 0) {
      unterminated = { construct: `unbalanced parentheses (depth ${depth})` };
    } else if (current.trim()) {
      statements.push(current);
    }
  }

  return { statements, unterminated };
}

const FILE_CREATE_TABLE = /^\s*CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"?\w+"?\.)?"?(\w+)"?\s*\(/i;
const FILE_ENABLE_RLS = /^\s*ALTER\s+TABLE\s+(?:"?\w+"?\.)?"?(\w+)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i;

/**
 * Given `text` (an already-vetted, single top-level statement — parseFile
 * guarantees it is balanced and contains no unterminated string, quoted
 * identifier, or dollar-quoted block) and the index of an opening '(' within
 * it, scan forward to the index of its EXACT matching ')'. Parens inside
 * string literals, quoted identifiers, or dollar-quoted blocks are skipped so
 * they cannot desync the count; nested parens (CHECK, DEFAULT with a function
 * call, composite types) are balanced correctly. Returns -1 if no matching
 * close is found before the end of `text` — the caller must treat that as a
 * parse failure, never as "the column list is empty".
 */
function findMatchingParen(text, openIndex) {
  let depth = 0;
  let i = openIndex;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (ch === "'") {
      i++;
      while (i < n) {
        if (text[i] === "'" && text[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (text[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < n) {
        if (text[i] === '"' && text[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "$") {
      let j = i + 1;
      let tag = "";
      while (j < n && /\w/.test(text[j])) {
        tag += text[j];
        j++;
      }
      if (text[j] === "$") {
        const dollarQuote = `$${tag}$`;
        const closeIdx = text.indexOf(dollarQuote, j + 1);
        if (closeIdx === -1) return -1;
        i = closeIdx + dollarQuote.length;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Collect facts from a single migration file: which tables it declares
 * (bare name, plus whether the column body mentions `workspace_id`), and
 * which tables it enables row level security on. Returns
 * `{ tables: [], rlsEnabled: [], unterminated }` with empty arrays when the
 * file could not be parsed to completion — an unterminated file yields no
 * facts at all, it is never partially trusted.
 *
 * The column body used for the `workspace_id` check is the EXACT span
 * between a CREATE TABLE's opening '(' and its matching ')' (via
 * `findMatchingParen`), never "everything from the opening paren to the end
 * of the statement." Anything after the real close — a trailing WITH (...)
 * clause, storage parameters, whatever — cannot satisfy the check just by
 * containing the word `workspace_id` (round 5, CRITICAL). If the matching
 * ')' cannot be found, the whole file fails closed rather than being
 * treated as a table with no columns.
 */
export function collectFileFacts(sql) {
  const { statements, unterminated } = parseFile(sql);
  if (unterminated) {
    return { tables: [], rlsEnabled: [], unterminated };
  }

  const foundTables = [];
  const rlsEnabled = [];

  for (const stmt of statements) {
    const createMatch = stmt.match(FILE_CREATE_TABLE);
    if (createMatch) {
      // The regex is anchored at ^ and ends in a literal '(', so its last
      // matched character is that opening paren's exact index in `stmt`.
      const parenStart = createMatch[0].length - 1;
      const parenEnd = findMatchingParen(stmt, parenStart);
      if (parenEnd === -1) {
        return {
          tables: [],
          rlsEnabled: [],
          unterminated: { construct: `unmatched '(' in CREATE TABLE ${createMatch[1]}` },
        };
      }
      const body = stmt.slice(parenStart + 1, parenEnd);
      foundTables.push({ name: createMatch[1], hasWorkspaceId: /\bworkspace_id\b/.test(body) });
      continue;
    }
    const alterMatch = stmt.match(FILE_ENABLE_RLS);
    if (alterMatch) {
      rlsEnabled.push(alterMatch[1]);
    }
  }

  return { tables: foundTables, rlsEnabled, unterminated: null };
}

/**
 * Aggregate per-file facts (as produced by `collectFileFacts`) into
 * violations, purely as data — no SQL text is ever concatenated here.
 * `fileFacts` is `[{ name: string, facts: ReturnType<collectFileFacts> }]`.
 *
 * A table created in one file and RLS-enabled in another still counts as
 * RLS-enabled: `rlsEnabled` names are unioned across every file regardless
 * of which file declared the table.
 *
 * Any file that failed to parse (`facts.unterminated` set) contributes no
 * tables and no RLS names, and is reported separately in
 * `unparseableFiles` so CI fails on it rather than silently certifying an
 * unreadable migration.
 */
export function computeViolations(fileFacts) {
  const unparseableFiles = [];
  const rlsEnabledTables = new Set();
  const seenTables = new Set();
  const tablesToCheck = [];

  for (const { name, facts } of fileFacts) {
    if (facts.unterminated) {
      unparseableFiles.push({ file: name, construct: facts.unterminated.construct });
    }
  }

  for (const { facts } of fileFacts) {
    for (const rlsName of facts.rlsEnabled) rlsEnabledTables.add(rlsName);
  }

  for (const { facts } of fileFacts) {
    if (facts.unterminated) continue;
    for (const t of facts.tables) {
      if (GLOBAL_TABLES.includes(t.name)) continue;
      if (seenTables.has(t.name)) continue;
      seenTables.add(t.name);
      tablesToCheck.push(t);
    }
  }

  const tenancyViolations = tablesToCheck.filter((t) => !t.hasWorkspaceId).map((t) => t.name);
  const rlsViolations = tablesToCheck.filter((t) => !rlsEnabledTables.has(t.name)).map((t) => t.name);

  return { tenancyViolations, rlsViolations, unparseableFiles };
}
