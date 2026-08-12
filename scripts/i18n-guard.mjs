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

// A bare template literal used directly as a JSX child expression, e.g.
// `{`Sổ điều hành`}` -- distinct from `{t(`...`)}`, which has a call
// between `{` and the backtick and so does not match this pattern.
const TEMPLATE_EXPR = /\{\s*`([^`]*)`\s*\}/g;

// Attribute values, scoped to inside an actual opening tag (`<... >`) so a
// plain JS assignment like `const greeting = "Xin chào"` outside JSX is
// never touched -- only real element/component attributes are attributes.
// Attribute-name-agnostic on purpose: round 0 only checked a fixed list
// (placeholder/aria-label/alt/title), which misses any attribute not named
// there (e.g. a `data-tooltip`); scoping to "inside a tag" instead of "on a
// list" closes that generally rather than by enumeration.
const OPEN_TAG = /<[a-zA-Z][\w.-]*\b[^>]*>/g;
const ATTR_STRING = /\b[a-zA-Z][\w-]*\s*=\s*"([^"{}]*)"/g;
const ATTR_TEMPLATE = /\b[a-zA-Z][\w-]*\s*=\s*\{\s*`([^`]*)`\s*\}/g;

function pushIfVietnamese(hits, text) {
  const trimmed = text.trim();
  if (trimmed.length > 0 && VIETNAMESE.test(trimmed)) hits.push(trimmed);
}

/** ADR-006: display strings live in the i18n layer, never inline in JSX. */
export function findHardcodedVietnamese(source) {
  const hits = [];
  for (const m of source.matchAll(JSX_TEXT)) pushIfVietnamese(hits, m[1]);
  for (const m of source.matchAll(POST_EXPR_TEXT)) pushIfVietnamese(hits, m[1]);
  for (const m of source.matchAll(PRE_EXPR_TEXT)) pushIfVietnamese(hits, m[1]);
  for (const m of source.matchAll(TEMPLATE_EXPR)) pushIfVietnamese(hits, m[1]);
  for (const tag of source.matchAll(OPEN_TAG)) {
    for (const a of tag[0].matchAll(ATTR_STRING)) pushIfVietnamese(hits, a[1]);
    for (const a of tag[0].matchAll(ATTR_TEMPLATE)) pushIfVietnamese(hits, a[1]);
  }
  return hits;
}
