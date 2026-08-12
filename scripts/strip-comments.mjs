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
// Known limit: the `//` stripper treats any `//` not immediately preceded
// by `:` as a comment start, so it will not be fooled by `href="https://..."`
// but WILL be fooled by a `//` that happens to appear inside a plain string
// value for some other reason (e.g. a literal path fragment in display
// text). Accepted: narrow, and a false negative here (missing content after
// a coincidental `//`) is a much smaller risk than what this module closes.
export function stripComments(source) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/(?<!:)\/\/[^\n]*/g, (m) => m.replace(/./g, " "));
  return out;
}
