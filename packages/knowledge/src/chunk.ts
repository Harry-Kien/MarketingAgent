export interface Chunk {
  text: string;
  ordinal: number;
}

/**
 * Greedy word-fill chunking, ~40 lines total for the whole module -- the
 * dependency audit's argument against a framework here is that ~300 lines
 * of hand-written code covers retrieve -> prompt -> generate end to end, so
 * this stays deliberately simple. Words are never split unless a single
 * word alone exceeds maxChars, in which case it is hard-split into
 * maxChars-sized pieces so no chunk ever exceeds the caller's limit.
 */
export function chunkDocument(text: string, maxChars: number): Chunk[] {
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    throw new Error(`chunkDocument requires maxChars to be a finite number > 0, got ${maxChars}`);
  }

  const trimmed = text.trim();
  if (trimmed === "") return [];

  const words = trimmed.split(/\s+/);
  const chunks: Chunk[] = [];
  let current = "";

  function pushCurrent(): void {
    if (current.length > 0) {
      chunks.push({ text: current, ordinal: chunks.length });
      current = "";
    }
  }

  for (const word of words) {
    if (word.length > maxChars) {
      pushCurrent();
      for (let i = 0; i < word.length; i += maxChars) {
        chunks.push({ text: word.slice(i, i + maxChars), ordinal: chunks.length });
      }
      continue;
    }
    const candidate = current === "" ? word : `${current} ${word}`;
    if (candidate.length > maxChars) {
      pushCurrent();
      current = word;
    } else {
      current = candidate;
    }
  }
  pushCurrent();

  return chunks;
}
