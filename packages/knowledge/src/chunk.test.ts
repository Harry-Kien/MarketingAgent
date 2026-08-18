import { describe, expect, it } from "vitest";
import { chunkDocument } from "./chunk.ts";

describe("chunkDocument", () => {
  it("returns a single chunk when the whole text fits within maxChars", () => {
    expect(chunkDocument("Xin chao the gioi", 100)).toEqual([{ text: "Xin chao the gioi", ordinal: 0 }]);
  });

  it("splits long text into multiple chunks, each within maxChars and ordinal-ordered, with no word lost", () => {
    const words = Array.from({ length: 20 }, (_, i) => `tu${i}`);
    const text = words.join(" ");
    const chunks = chunkDocument(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => {
      expect(c.ordinal).toBe(i);
      expect(c.text.length).toBeLessThanOrEqual(30);
    });
    expect(chunks.flatMap((c) => c.text.split(" "))).toEqual(words);
  });

  it("hard-splits a single token longer than maxChars into fixed-size pieces", () => {
    const longWord = "a".repeat(75);
    const chunks = chunkDocument(longWord, 30);
    expect(chunks).toEqual([
      { text: "a".repeat(30), ordinal: 0 },
      { text: "a".repeat(30), ordinal: 1 },
      { text: "a".repeat(15), ordinal: 2 },
    ]);
  });

  it("returns an empty array for blank or whitespace-only input", () => {
    expect(chunkDocument("   \n\t  ", 100)).toEqual([]);
    expect(chunkDocument("", 100)).toEqual([]);
  });

  it("throws when maxChars is not a positive number", () => {
    expect(() => chunkDocument("hello", 0)).toThrow(/maxChars/);
    expect(() => chunkDocument("hello", -5)).toThrow(/maxChars/);
  });
});
