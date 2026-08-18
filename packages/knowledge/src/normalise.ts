/**
 * D6: the same Vietnamese string exists in composed (NFC) and decomposed
 * (NFD) Unicode byte forms -- a diacritic can be one precomposed code point
 * or a base letter followed by combining marks. Skipping normalisation
 * before chunking, embedding or querying makes identical text retrieve
 * differently, silently and with no error, because the two byte forms hash
 * and embed differently even though a human reads them as the same word.
 * NFC is chosen (not NFD) because it is what a Vietnamese keyboard/IME
 * actually produces and what most stored text already is.
 */
export function normaliseVietnamese(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}
