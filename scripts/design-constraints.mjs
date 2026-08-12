const LINE_HEIGHT = /(?:line-height:\s*|leading-\[)\s*(\d(?:\.\d+)?)/g;
const DISPLAY_ELEMENT = /<[^>]*font-display[^>]*>([^<]*)<\/[^>]+>/g;
const BANNED = [
  { name: "gradient", re: /linear-gradient|radial-gradient|conic-gradient/ },
  { name: "backdrop-filter", re: /backdrop-filter/ },
  { name: "text-shadow glow", re: /text-shadow:[^;]*\d{2,}px/ },
];

// Tailwind's named leading-* utilities below the 1.3 floor. A literal numeric
// regex can never catch these because the class name carries no digits, so
// `leading-tight` (1.25) or `leading-none` (1) would otherwise slip straight
// past LINE_HEIGHT undetected.
const SUB_FLOOR_LEADING_CLASSES = { "leading-none": "1", "leading-tight": "1.25" };
const LEADING_CLASS_NAME = /leading-(none|tight)\b/g;

export function findLineHeightViolations(source) {
  const hits = [];
  for (const m of source.matchAll(LINE_HEIGHT)) {
    if (Number(m[1]) < 1.3) hits.push(m[1]);
  }
  for (const m of source.matchAll(LEADING_CLASS_NAME)) {
    hits.push(SUB_FLOOR_LEADING_CLASSES[`leading-${m[1]}`]);
  }
  return hits;
}

// A JS unicode escape for U+00B7 (`·` or `\u{b7}`) renders as the same
// glyph once compiled, so a bare `.includes("·")` on the literal character
// would miss it. Source-level scanning cannot see through arbitrary
// construction (String.fromCharCode, concatenation, etc.) but this common
// case is cheap to close.
const MIDDOT_ESCAPE = /\\u\{?00b7\}?/i;

/** ADR-008 C2: Archivo has no U+00B7, so it silently falls back. */
export function findArchivoMiddot(source) {
  const hits = [];
  for (const m of source.matchAll(DISPLAY_ELEMENT)) {
    if (m[1].includes("·") || MIDDOT_ESCAPE.test(m[1])) hits.push(m[0]);
  }
  return hits;
}

export function findBannedVisuals(source) {
  const hits = [];
  for (const b of BANNED) if (b.re.test(source)) hits.push(b.name);
  for (const m of source.matchAll(/border-radius:\s*(\d+)px/g)) {
    if (Number(m[1]) > 6) hits.push(m[0]);
  }
  return hits;
}
