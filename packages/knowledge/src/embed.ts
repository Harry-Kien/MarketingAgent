export interface Embedder {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * FNV-1a, chosen only because it is small, dependency-free, and stable
 * across Node versions -- not for any cryptographic property. Maps a seed
 * string to a value in [-1, 1] deterministically: same seed, same output,
 * forever, on any machine.
 */
function hashToUnit(seed: string): number {
  let h = 2166136261 >>> 0; // FNV-1a offset basis
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h / 0xffffffff) * 2 - 1;
}

/**
 * Deterministic by construction: reads no clock, generates no random
 * numbers, makes no network call. Every M2A/M2C test that needs an
 * embedding runs against this so that no test or CI run ever calls a paid
 * embedding API (Global Constraint: "Embedding calls in tests use a fake
 * embedder"), mirroring packages/model-gateway/src/fake.ts's own header for
 * the same reason on the model-provider side.
 */
export function createFakeEmbedder(dimensions: number): Embedder {
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    throw new Error(`createFakeEmbedder requires dimensions to be a finite number > 0, got ${dimensions}`);
  }
  return {
    name: "fake",
    dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => Array.from({ length: dimensions }, (_, i) => hashToUnit(`${text}:${i}`)));
    },
  };
}
