import { scanTags } from "./tag-scanner.mjs";
import { stripComments } from "./strip-comments.mjs";

// ---------------------------------------------------------------------------
// C1 -- line-height must be a unitless ratio >= 1.3 (ADR-008, measured in
// docs/research/font-render-verification.md). Fix round 1 widened this past
// the plan's single bare-CSS-property regex: React inline style, CSS custom
// properties, calc(), the font shorthand's slash ratio, Tailwind's named
// leading-* classes, case, and whitespace around the colon. Fix round 2:
// leading-dot decimals (`.9`) and quoted style-object values (`"1.1"`,
// `"14px"`), the single-line vertical-centering idiom, a documented
// suppression escape hatch, and comments no longer read as literal values.
// ---------------------------------------------------------------------------
const UNIT = "(px|rem|em|pt|%|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pc)";
// Leading sign (`+`/`-`) and a leading-dot decimal (`.9`, no digit before the
// point) are both valid JS/CSS numeric literals that the round-1 pattern
// (`-?\d+(?:\.\d+)?`) could not match at all.
const NUM = "([+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+))";

// `.x { line-height: 1.2; }`, `LINE-HEIGHT` (case-insensitive), whitespace
// before the colon, and `calc(1.1)`.
const LH_PROPERTY = new RegExp(`line-height\\s*:\\s*(?:calc\\(\\s*)?${NUM}\\s*${UNIT}?`, "gi");
// `style={{ lineHeight: 1.1 }}` -- React's numeric inline-style value for
// lineHeight is unitless by convention. Also tolerates an optional quote on
// either side so `lineHeight: "1.1"` and `lineHeight: "14px"` (both fully
// evaded round 1) are seen the same way as their unquoted forms.
const LH_JS_STYLE = new RegExp(`lineHeight\\s*:\\s*["']?${NUM}\\s*${UNIT}?["']?`, "g");
// `:root { --lh-x: 1.1; }` or `--heading-line-height: 1.1;` -- a design-token
// custom property whose name says it holds a line-height. This is a naming
// convention (tokens.ts uses `--lh-*` exclusively for this), not a general
// CSS fact -- documented here since a static scan can't know it any other way.
const LH_CUSTOM_PROP = new RegExp(`--(?:lh-[\\w-]*|[\\w-]*line-height[\\w-]*)\\s*:\\s*(?:calc\\(\\s*)?${NUM}\\s*${UNIT}?`, "gi");
// `font: 700 14px/1.1 Archivo;` -- the shorthand's line-height sits after the
// slash. Isolate the shorthand's full value first, then look for the slash
// ratio inside just that substring, rather than one large lazy regex (which
// risks pathological backtracking on adversarial input).
const FONT_RULE = /font\s*:\s*([^;{}]+);/gi;
const FONT_SLASH_VALUE = new RegExp(`/\\s*${NUM}\\s*${UNIT}?`);
const LEADING_BRACKET = /leading-\[\s*(-?\d+(?:\.\d+)?)\s*\]/g;
// Tailwind's named leading-* utilities below the 1.3 floor. A literal numeric
// regex can never catch these because the class name carries no digits, so
// `leading-tight` (1.25) or `leading-none` (1) would otherwise slip straight
// past every numeric pattern above. leading-snug/normal/relaxed/loose are
// all >= 1.3 and must NOT be listed here.
const SUB_FLOOR_LEADING_CLASSES = { "leading-none": "1", "leading-tight": "1.25" };
const LEADING_CLASS_NAME = /leading-(none|tight)\b/g;

function lineAt(source, index) {
  const start = source.lastIndexOf("\n", index) + 1;
  let end = source.indexOf("\n", index);
  if (end === -1) end = source.length;
  return source.slice(start, end);
}

// Fix round 2: a reviewed, deliberate exception. `/* c1-ok: <reason> */` on
// the SAME line as the flagged declaration suppresses that one occurrence,
// but only with a written reason -- an empty or missing reason does not
// suppress, so an exception is visible on `grep c1-ok` in review rather than
// invisible. The escape hatch for a genuinely safe absolute-unit case the
// height-matching heuristic below doesn't recognise.
const SUPPRESS = /\/\*\s*c1-ok:\s*(\S.*?)\s*\*\//;
function isSuppressed(source, index) {
  const m = SUPPRESS.exec(lineAt(source, index));
  return Boolean(m && m[1].trim().length > 0);
}

function enclosingBlock(source, index) {
  const open = source.lastIndexOf("{", index);
  if (open === -1) return null;
  const close = source.indexOf("}", index);
  if (close === -1) return null;
  return source.slice(open + 1, close);
}

// Fix round 2: recognises the standard single-line vertical-centering idiom
// -- an absolute line-height exactly equal to an explicit `height` in the
// same rule/style block. This sits outside C1's measured risk: the evidence
// (font-render-verification V6 S3.3) is about MULTI-line text where one
// line's line-box collides with the next line's diacritics; a block whose
// line-height equals its own height has exactly one line by construction,
// so there is no second line box to collide with. Recognised, not just
// suppressed, so this specific common pattern needs no developer action.
// `(?<!line-)` keeps this from matching the "height" substring inside
// "line-height" itself. Unitless numeric height values (React's own
// convention, e.g. `height: 32`) are normalised to px before comparing,
// since that's what React does at render time.
function hasMatchingHeight(block, value, unit) {
  const m = /(?<!line-)\bheight\s*:\s*["']?(-?[\d.]+(?:px|rem|em|pt|%|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pc)?)["']?\b/i.exec(block);
  if (!m) return false;
  const raw = m[1];
  const normalized = /[a-z%]/i.test(raw) ? raw : `${raw}px`;
  return normalized.toLowerCase() === `${value}${unit}`.toLowerCase();
}

// Decision (fix round 1, refined round 2): absolute units are refused by
// default, not resolved -- C1 is a ratio of line box to font size, and
// resolving e.g. `20px` into that ratio would need the element's computed
// font-size, which can come from an ancestor, a design token, or an
// unrelated Tailwind text-* class nowhere near this line. A static text
// scan cannot do that reliably, so a wrong "it's fine" would be worse than
// an over-eager reject. Two narrow, deliberate exceptions to the refusal
// (not to the ratio floor itself): the single-line height-match idiom above,
// and a `c1-ok` suppression comment for everything else genuinely reviewed.
function considerLineHeight(hits, source, index, value, unit) {
  if (isSuppressed(source, index)) return;
  if (unit) {
    const block = enclosingBlock(source, index);
    if (block && hasMatchingHeight(block, value, unit)) return;
    hits.push(
      `${value}${unit} (absolute unit refused: C1 is a ratio floor, not a length. ` +
        `Use a unitless ratio >= 1.3, OR if this is a single-line block whose line-height ` +
        `intentionally equals its height, add a matching "height: ${value}${unit}" in the same ` +
        `rule, OR if reviewed and safe for another documented reason, add "/* c1-ok: <reason> */" ` +
        `on this line)`,
    );
    return;
  }
  if (Number(value) < 1.3) hits.push(value);
}

export function findLineHeightViolations(source) {
  const hits = [];
  // Scan a comment-stripped copy so a comment documenting or exemplifying a
  // banned value isn't itself read as one; positions are preserved so
  // match.index still points at the right place in the ORIGINAL `source`,
  // which the suppression-comment and height-block lookups need intact.
  const scan = stripComments(source);
  for (const m of scan.matchAll(LH_PROPERTY)) considerLineHeight(hits, source, m.index, m[1], m[2]);
  for (const m of scan.matchAll(LH_JS_STYLE)) considerLineHeight(hits, source, m.index, m[1], m[2]);
  for (const m of scan.matchAll(LH_CUSTOM_PROP)) considerLineHeight(hits, source, m.index, m[1], m[2]);
  for (const rule of scan.matchAll(FONT_RULE)) {
    const sm = FONT_SLASH_VALUE.exec(rule[1]);
    if (sm) considerLineHeight(hits, source, rule.index + rule[0].indexOf(rule[1]) + sm.index, sm[1], sm[2]);
  }
  for (const m of scan.matchAll(LEADING_BRACKET)) {
    if (Number(m[1]) < 1.3) hits.push(m[1]);
  }
  for (const m of scan.matchAll(LEADING_CLASS_NAME)) {
    hits.push(SUB_FLOOR_LEADING_CLASSES[`leading-${m[1]}`]);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// C2 -- Archivo has no U+00B7 glyph (measured in font-render-verification.md
// section 3.2). Fix round 1 added: a depth-tracked tag scan so a middot
// nested under (not just a direct child of) a font-display ancestor is still
// caught; HTML entity forms; and a separate, explicitly-labelled check for
// visually similar dot/bullet characters, which is a DIFFERENT rule (an
// anti-generic-look concern, since their Archivo coverage has never been
// measured) from C2 itself. Fix round 2: comments (JSX `{/* */}`, `//`, and
// `/* */` in the surrounding code) are stripped before scanning, so a
// comment documenting the rule is never mistaken for breaking it; the
// ad-hoc tag regex was replaced with the shared `scanTags` tokenizer, which
// does not truncate on a `>` inside a brace-expression attribute.
// ---------------------------------------------------------------------------
const MIDDOT_LITERAL = /·/;
const MIDDOT_ENTITY = /&(?:middot|#0*183|#x0*b7);/i;
// A JS unicode escape for U+00B7 resolves to the same glyph once compiled,
// so a bare literal-character check would miss it in raw source text.
const MIDDOT_ESCAPE = /\\u\{?0*b7\}?/i;
// Visually similar separators someone might reach for instead of a middot.
// NOT measured for Archivo coverage the way U+00B7 was -- banned as a
// design-consistency/anti-generic-look call, not as C2 itself. Keep this
// distinction in the emitted message.
const LOOKALIKE = /[•⋅∙]/; // U+2022 bullet, U+22C5 dot operator, U+2219 bullet operator

function currentFontRule(stack) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].override) return "override";
    if (stack[i].display) return "display";
  }
  return "none";
}

export function findArchivoMiddot(source) {
  const hits = [];
  const stack = [];
  for (const tok of scanTags(stripComments(source))) {
    if (tok.kind === "text") {
      if (tok.value.trim().length === 0) continue;
      if (currentFontRule(stack) !== "display") continue;
      if (MIDDOT_LITERAL.test(tok.value) || MIDDOT_ENTITY.test(tok.value) || MIDDOT_ESCAPE.test(tok.value)) {
        hits.push({ text: tok.value.trim(), rule: "ADR-008 C2: U+00B7 has no glyph in Archivo, so it silently falls back to another font" });
      } else if (LOOKALIKE.test(tok.value)) {
        hits.push({ text: tok.value.trim(), rule: "anti-generic-look: dot/bullet lookalike separator (not the measured C2 glyph) -- use — or a CSS border separator" });
      }
    } else if (tok.kind === "close") {
      stack.pop();
    } else if (tok.kind === "open") {
      const display = /font-display/.test(tok.attrs);
      const override = /font-(?:body|mono)/.test(tok.attrs);
      if (!tok.selfClosing) stack.push({ display, override });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Anti-AI-look. Fix round 2: also scans a comment-stripped copy, for the
// same reason as C1/C2 -- a comment mentioning a banned pattern to document
// or warn against it should not itself trip the guard.
// ---------------------------------------------------------------------------
const BANNED = [
  { name: "gradient", re: /linear-gradient|radial-gradient|conic-gradient/ },
  { name: "backdrop-filter", re: /backdrop-filter/ },
  { name: "text-shadow glow", re: /text-shadow:[^;]*\d{2,}px/ },
];

export function findBannedVisuals(source) {
  const hits = [];
  const scan = stripComments(source);
  for (const b of BANNED) if (b.re.test(scan)) hits.push(b.name);
  for (const m of scan.matchAll(/border-radius:\s*(\d+)px/g)) {
    if (Number(m[1]) > 6) hits.push(m[0]);
  }
  return hits;
}
