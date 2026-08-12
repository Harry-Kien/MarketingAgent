const VIETNAMESE = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ]/;
const JSX_TEXT = />([^<>{}]+)</g;
// A hard-coded Vietnamese string is just as much a violation sitting in an
// accessibility/placeholder attribute as it is in JSX text -- a screen
// reader reads `aria-label` aloud regardless of whether it came through
// t(). JSX_TEXT alone cannot see this because attribute values never sit
// between a bare `>` and `<`.
const ATTR_TEXT = /(?:placeholder|aria-label|alt|title)\s*=\s*"([^"{}]*)"/g;

/** ADR-006: display strings live in the i18n layer, never inline in JSX. */
export function findHardcodedVietnamese(source) {
  const hits = [];
  for (const m of source.matchAll(JSX_TEXT)) {
    if (VIETNAMESE.test(m[1]) && m[1].trim().length > 0) hits.push(m[1].trim());
  }
  for (const m of source.matchAll(ATTR_TEXT)) {
    if (VIETNAMESE.test(m[1]) && m[1].trim().length > 0) hits.push(m[1].trim());
  }
  return hits;
}
