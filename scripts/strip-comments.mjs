// Blanks out `/* ... */` block comments (which also covers the JSX
// `{/* ... */}` comment idiom -- it's just a block comment inside a JS
// expression container, nothing more) and `//` line comments, replacing
// each comment character with a space so positions/newlines are preserved
// and nothing before or after a comment shifts. Every guard in this file
// runs its source through this first, so a comment documenting or
// exemplifying a banned pattern -- `// don't use line-height: 1.1`,
// `{/* separator uses · like this */}` -- is not itself treated as the
// violation it's describing.
//
// Fix round 3: this used to be two regexes, with the `//` one guarded by a
// `(?<!:)` lookbehind so `href="https://..."` wasn't misread as a comment
// start. That guard only inspected the ONE character before `//`, so any
// OTHER `//` inside an ordinary string value -- `placeholder="Giá // 100"`,
// with nothing resembling a URL scheme -- was still treated as a comment,
// blanking the rest of the line: every attribute after it on that line, not
// just the string containing `//`. `<a href="https://example.com"
// aria-label="...">` happened to survive only because `:` came first; a
// plain string with a stray `//` did not, and links are ordinary code in a
// web app, not a deliberate edge case.
//
// This is now a small character-by-character scanner instead of two
// independent regexes: string literals (single, double, backtick, with
// backslash-escape awareness) are copied through verbatim, so nothing
// inside them -- `//`, `/*`, or otherwise -- is ever mistaken for a
// comment, regardless of what character happens to precede it. Comments
// are only recognised OUTSIDE a string.
//
// Known limit, inherent to a lexer that doesn't fully parse `${...}`
// interpolations inside template literals: a genuine `//`/`/* */` comment
// nested inside a template literal's `${}` expression is treated as part of
// the string (not stripped), which is the safer direction -- it risks a
// false positive (an inner comment read as content) rather than a false
// negative, and interpolated comments inside template literals are rare in
// the file types this guard scans (JSX attribute values, CSS).
export function stripComments(source) {
  let out = "";
  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < n) {
          out += source[i] + source[i + 1];
          i += 2;
          continue;
        }
        out += source[i];
        i++;
      }
      if (i < n) {
        out += source[i]; // closing quote
        i++;
      }
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      let end = source.indexOf("\n", i);
      if (end === -1) end = n;
      out += source.slice(i, end).replace(/./g, " ");
      i = end;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
