// ---------------------------------------------------------------------------
// C1 -- line-height must be a unitless ratio >= 1.3 (ADR-008, measured in
// docs/research/font-render-verification.md). Fix round 1 widened this past
// the plan's single bare-CSS-property regex: React inline style, CSS custom
// properties, calc(), the font shorthand's slash ratio, Tailwind's named
// leading-* classes, case, and whitespace around the colon.
// ---------------------------------------------------------------------------
const UNIT = "(px|rem|em|pt|%|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pc)";
const NUM = "(-?\\d+(?:\\.\\d+)?)";

// `.x { line-height: 1.2; }`, `LINE-HEIGHT` (case-insensitive), whitespace
// before the colon, and `calc(1.1)`.
const LH_PROPERTY = new RegExp(`line-height\\s*:\\s*(?:calc\\(\\s*)?${NUM}\\s*${UNIT}?`, "gi");
// `style={{ lineHeight: 1.1 }}` -- React's numeric inline-style value for
// lineHeight is unitless by convention; a quoted string with a unit is also
// tolerated by this pattern and routed through the same absolute-unit policy.
const LH_JS_STYLE = new RegExp(`lineHeight\\s*:\\s*${NUM}\\s*${UNIT}?`, "g");
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

// Decision (fix round 1): absolute units are refused outright, not resolved.
// C1 is a ratio of line box to font size; resolving `20px` into a ratio would
// require knowing the element's computed font-size, which can come from an
// ancestor, a design-token variable, or a Tailwind text-* class nowhere near
// this line -- a static text scan cannot do that reliably. A wrong pass is
// worse than an over-eager reject, and tokens.ts is the one legitimate place
// a line-height is defined; every call site should reference it as the
// unitless ratio it already is.
function considerLineHeight(hits, value, unit) {
  if (unit) {
    hits.push(`${value}${unit} (absolute unit refused: C1 is a ratio floor, not a length -- express line-height as a unitless number)`);
    return;
  }
  if (Number(value) < 1.3) hits.push(value);
}

export function findLineHeightViolations(source) {
  const hits = [];
  for (const m of source.matchAll(LH_PROPERTY)) considerLineHeight(hits, m[1], m[2]);
  for (const m of source.matchAll(LH_JS_STYLE)) considerLineHeight(hits, m[1], m[2]);
  for (const m of source.matchAll(LH_CUSTOM_PROP)) considerLineHeight(hits, m[1], m[2]);
  for (const rule of source.matchAll(FONT_RULE)) {
    const sm = FONT_SLASH_VALUE.exec(rule[1]);
    if (sm) considerLineHeight(hits, sm[1], sm[2]);
  }
  for (const m of source.matchAll(LEADING_BRACKET)) {
    if (Number(m[1]) < 1.3) hits.push(m[1]);
  }
  for (const m of source.matchAll(LEADING_CLASS_NAME)) {
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
// measured) from C2 itself.
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

// A lightweight tag-shape scanner, not a real parser: it tracks open/close
// tags and the text runs between them so nested descendants of a
// font-display ancestor are covered, not just a direct child. A descendant
// that itself declares font-body/font-mono is treated as escaping the
// Archivo region for its own subtree, matching the real CSS cascade
// (nearest ancestor wins). Known limits: no validation that close tags pair
// with the right open tag, and JSX fragments (`<>`) are invisible to it --
// acceptable because this guard scans compiled TSX/CSS, not arbitrary
// markup, and a wrong tag-name pairing only widens or narrows the region by
// one level, it doesn't invert the result.
const TOKEN = /<\/([a-zA-Z][\w.-]*)\s*>|<([a-zA-Z][\w.-]*)\b([^>]*?)(\/?)>|([^<]+)/g;

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
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(source))) {
    const [, closeTag, openTag, attrs, selfClose, text] = m;
    if (text !== undefined) {
      if (text.trim().length === 0) continue;
      if (currentFontRule(stack) !== "display") continue;
      if (MIDDOT_LITERAL.test(text) || MIDDOT_ENTITY.test(text) || MIDDOT_ESCAPE.test(text)) {
        hits.push({ text: text.trim(), rule: "ADR-008 C2: U+00B7 has no glyph in Archivo, so it silently falls back to another font" });
      } else if (LOOKALIKE.test(text)) {
        hits.push({ text: text.trim(), rule: "anti-generic-look: dot/bullet lookalike separator (not the measured C2 glyph) -- use — or a CSS border separator" });
      }
      continue;
    }
    if (closeTag) {
      stack.pop();
      continue;
    }
    if (openTag) {
      const display = /font-display/.test(attrs);
      const override = /font-(?:body|mono)/.test(attrs);
      if (!selfClose) stack.push({ display, override });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Anti-AI-look (unchanged in fix round 1 -- not flagged by the reviewer).
// ---------------------------------------------------------------------------
const BANNED = [
  { name: "gradient", re: /linear-gradient|radial-gradient|conic-gradient/ },
  { name: "backdrop-filter", re: /backdrop-filter/ },
  { name: "text-shadow glow", re: /text-shadow:[^;]*\d{2,}px/ },
];

export function findBannedVisuals(source) {
  const hits = [];
  for (const b of BANNED) if (b.re.test(source)) hits.push(b.name);
  for (const m of source.matchAll(/border-radius:\s*(\d+)px/g)) {
    if (Number(m[1]) > 6) hits.push(m[0]);
  }
  return hits;
}
