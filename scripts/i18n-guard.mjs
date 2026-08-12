import { scanTags } from "./tag-scanner.mjs";
import { stripComments } from "./strip-comments.mjs";

const VIETNAMESE = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ]/;

// Plain JSX text: directly between a tag's `>` and the next `<`.
const JSX_TEXT = />([^<>{}]+)</g;
// Fix round 1: text sitting right after a `{expr}` JSX child expression,
// before the next tag -- e.g. `{name}, đây là báo cáo` -- which JSX_TEXT
// cannot see because it requires the run to START at `>`. Mirrors JSX_TEXT
// from the other side of the brace.
const POST_EXPR_TEXT = /\}([^<>{}]+)</g;
// And the symmetric case: text sitting right BEFORE a `{expr}`, e.g.
// `Chào {name}` -- JSX_TEXT can't see this either, since the run has to end
// at `<`, not `{`.
// Shared false-positive note for both of the above: `{` and `}` are common
// in plain TS for reasons that have nothing to do with JSX (block/object
// ends, generics, comparisons), but a `}`/`{` immediately abutting unbroken
// non-tag text and then a `<`/`>` is specific to JSX -- comparisons and
// generics don't produce this exact shape. Risk accepted per fix-round-1
// direction; the VIETNAMESE check is the real backstop against noise, since
// non-Vietnamese code adjacent to a brace is never flagged regardless.
const PRE_EXPR_TEXT = />([^<>{}]+)\{/g;
// Fix round 2 (self-discovered while building the false-positive fixture,
// not reported by the reviewer): text sitting BETWEEN two consecutive
// interpolations, e.g. `{t("a")} và {t("b")}` -- neither POST_EXPR_TEXT
// (which must end at `<`) nor PRE_EXPR_TEXT (which must start at `>`)
// covers this middle case. Same shape, same accepted false-positive
// reasoning as the two patterns above.
const BETWEEN_EXPR_TEXT = /\}([^<>{}]+)\{/g;

// A bare template literal used directly as a JSX child expression, e.g.
// `{`Sổ điều hành`}` -- distinct from `{t(`...`)}`, which has a call
// between `{` and the backtick and so does not match this pattern.
const TEMPLATE_EXPR = /\{\s*`([^`]*)`\s*\}/g;

// Attribute name+value pairs. Fix round 2: matched only inside a tag body
// produced by the shared `scanTags` tokenizer (which tracks brace depth), so
// a `>` inside a conditional/generic attribute expression -- e.g.
// `<Badge variant={score > threshold ? "a" : "b"} placeholder="...">` --
// does not truncate the scan the way the round-1 `<[^>]*>` regex did.
//
// Fix round 4: this only matched double-quoted values (`attr="..."`) --
// `attr='...'` is plain, ordinary, valid JSX (half the ways a developer
// writes an attribute, not an edge case) and was invisible to the guard
// entirely, for EVERY attribute, visible or not, since the bug is in value
// extraction itself, before isUserVisibleAttr ever runs. Two alternatives
// (double-quoted / single-quoted) via named groups, each escape-aware
// (`(?:[^"\\]|\\.)*` / `(?:[^'\\]|\\.)*`) so a `\'` inside a single-quoted
// value, or a `\"` inside a double-quoted one, doesn't end the match early
// and corrupt the rest of the scan.
const ATTR_STRING =
  /\b(?<dname>[a-zA-Z][\w-]*)\s*=\s*"(?<dval>(?:[^"\\]|\\.)*)"|\b(?<sname>[a-zA-Z][\w-]*)\s*=\s*'(?<sval>(?:[^'\\]|\\.)*)'/g;
const ATTR_TEMPLATE = /\b([a-zA-Z][\w-]*)\s*=\s*\{\s*`([^`]*)`\s*\}/g;

// Fix round 2: attributes that never render text to a human -- structural or
// behavioural wiring (test hooks, identifiers, styling/routing handles), not
// display copy. Deliberately a DENYLIST of known non-visible names/prefixes,
// not an allowlist of known visible ones: an attribute this list has never
// heard of still defaults to being scanned, so a real future gap (a new
// text-bearing prop) is not silently exempted the way round 0's four-name
// *allow*list would have exempted everything NOT on it. `data-*` is always
// exempt (test-automation slugs and custom data, per the reviewer); the
// listed ARIA attributes are IDREFs/booleans/enums, not rendered text --
// `aria-label` is deliberately NOT here, because unlike those it IS read
// aloud by assistive tech.
const NOT_VISIBLE_NAMES = new Set([
  "key", "id", "className", "class", "type", "role", "href", "name",
  "htmlFor", "for", "target", "rel", "method", "action", "tabIndex",
  "tabindex", "style", "ref",
]);
const NOT_VISIBLE_ARIA = new Set([
  "aria-hidden", "aria-describedby", "aria-labelledby", "aria-controls",
  "aria-owns", "aria-activedescendant", "aria-live", "aria-atomic",
  "aria-busy", "aria-current", "aria-checked", "aria-selected",
  "aria-expanded", "aria-pressed", "aria-disabled", "aria-invalid",
  "aria-required", "aria-multiselectable", "aria-orientation", "aria-sort",
  "aria-haspopup", "aria-modal", "aria-readonly", "aria-valuemin",
  "aria-valuemax", "aria-valuenow", "aria-flowto", "aria-details",
  "aria-posinset", "aria-setsize", "aria-level", "aria-colcount",
  "aria-colindex", "aria-colspan", "aria-rowcount", "aria-rowindex",
  "aria-rowspan",
]);
function isUserVisibleAttr(name) {
  if (name.startsWith("data-")) return false;
  if (NOT_VISIBLE_NAMES.has(name)) return false;
  if (NOT_VISIBLE_ARIA.has(name)) return false;
  return true;
}

function pushIfVietnamese(hits, text) {
  const trimmed = text.trim();
  if (trimmed.length > 0 && VIETNAMESE.test(trimmed)) hits.push(trimmed);
}

/** ADR-006: display strings live in the i18n layer, never inline in JSX. */
export function findHardcodedVietnamese(source) {
  const hits = [];
  // Scan a comment-stripped copy so a comment documenting or exemplifying a
  // hard-coded string isn't itself treated as one.
  const scan = stripComments(source);
  for (const m of scan.matchAll(JSX_TEXT)) pushIfVietnamese(hits, m[1]);
  for (const m of scan.matchAll(POST_EXPR_TEXT)) pushIfVietnamese(hits, m[1]);
  for (const m of scan.matchAll(PRE_EXPR_TEXT)) pushIfVietnamese(hits, m[1]);
  for (const m of scan.matchAll(BETWEEN_EXPR_TEXT)) pushIfVietnamese(hits, m[1]);
  for (const m of scan.matchAll(TEMPLATE_EXPR)) pushIfVietnamese(hits, m[1]);
  for (const tok of scanTags(scan)) {
    if (tok.kind !== "open") continue;
    for (const a of tok.attrs.matchAll(ATTR_STRING)) {
      const name = a.groups.dname ?? a.groups.sname;
      const value = a.groups.dval ?? a.groups.sval;
      if (isUserVisibleAttr(name)) pushIfVietnamese(hits, value);
    }
    for (const a of tok.attrs.matchAll(ATTR_TEMPLATE)) {
      if (isUserVisibleAttr(a[1])) pushIfVietnamese(hits, a[2]);
    }
  }
  return hits;
}
