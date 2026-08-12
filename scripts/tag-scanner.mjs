// A lightweight, dependency-free JSX/HTML-shaped tag scanner shared by the
// design-constraints and i18n guards. Not a real parser -- it doesn't
// validate that a closing tag matches its opener, and a bare JSX fragment
// (`<>`) is invisible to it (falls through as plain text either side).
//
// What it DOES get right, which the naive `<[^>]*>` / `[^>]*?>` regexes both
// of the guards started with do not: an opening tag's attribute list can
// contain a `{...}` expression with its own `>` (a comparison, a ternary, a
// generic) without truncating the tag scan early, because it tracks brace
// depth and skips over quoted attribute-value contents while searching for
// the tag's real closing `>`. This closes the same class of bug in both
// findArchivoMiddot's nesting (fix round 1) and the i18n guard's attribute
// extraction (reported against it in fix round 2) using one implementation
// instead of two independently-drifting ones.
//
// Fix round 3: a TSX generic component instantiation -- `<Select<string>
// placeholder="..." />` -- was invisible too, for a related reason: the tag
// NAME regex stops at the second `<` (not a name character), so the
// closing-`>`search started scanning from inside the generic argument list
// itself and stopped at the FIRST `>` it found there, treating
// `<Select<string>` as a complete (and wrong) tag with every attribute
// after it left as unmatched trailing text. `GENERIC_ARGS` greedily
// consumes a leading `<...>` run right after the name -- including nested
// levels and any extra immediately-trailing `>` characters -- as part of
// the tag's prefix before the real attribute/closing-bracket search
// begins. This is deliberately permissive, not a precise type-parameter
// parser: matching `>>`/`>>>` against the right nesting level is a genuine
// ambiguity even real TypeScript parsers special-case, and getting it
// exactly right is out of proportion for a lint scanner whose job is just
// to not lose the attribute list that follows.
const GENERIC_ARGS = /^<[^<>]*(?:<[^<>]*>[^<>]*)*>+/;

export function scanTags(source) {
  const tokens = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    if (source[i] === "<") {
      if (source[i + 1] === "/") {
        const m = /^<\/([a-zA-Z][\w.-]*)\s*>/.exec(source.slice(i));
        if (m) {
          tokens.push({ kind: "close", name: m[1], start: i, end: i + m[0].length });
          i += m[0].length;
          continue;
        }
      } else if (/[a-zA-Z]/.test(source[i + 1] || "")) {
        const nameMatch = /^<([a-zA-Z][\w.-]*)/.exec(source.slice(i));
        if (nameMatch) {
          const tagStart = i;
          let j = i + nameMatch[0].length;
          if (source[j] === "<") {
            const genericMatch = GENERIC_ARGS.exec(source.slice(j));
            if (genericMatch) j += genericMatch[0].length;
          }
          let depth = 0;
          let closedAt = -1;
          while (j < n) {
            const ch = source[j];
            if (ch === '"' || ch === "'" || ch === "`") {
              const quote = ch;
              j++;
              while (j < n && source[j] !== quote) j++;
            } else if (ch === "{") {
              depth++;
            } else if (ch === "}") {
              depth--;
            } else if (depth <= 0 && ch === ">") {
              closedAt = j;
              break;
            }
            j++;
          }
          if (closedAt !== -1) {
            const body = source.slice(tagStart, closedAt + 1);
            const selfClosing = source[closedAt - 1] === "/";
            tokens.push({ kind: "open", name: nameMatch[1], attrs: body, selfClosing, start: tagStart, end: closedAt + 1 });
            i = closedAt + 1;
            continue;
          }
        }
      }
    }
    // Not a recognized tag boundary here -- accumulate as text up to the
    // next `<` so a stray `<` (a comparison in plain code, or an
    // unterminated/malformed tag) degrades to being swept into a text run
    // instead of breaking the scan.
    let j = i + 1;
    while (j < n && source[j] !== "<") j++;
    tokens.push({ kind: "text", value: source.slice(i, j), start: i, end: j });
    i = j;
  }
  return tokens;
}
