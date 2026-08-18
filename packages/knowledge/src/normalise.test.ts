import { describe, expect, it } from "vitest";
import { normaliseVietnamese } from "./normalise.ts";

describe("normaliseVietnamese", () => {
  it("normalises decomposed and composed forms of the same Vietnamese word to the identical byte sequence", () => {
    const composed = "Tiếng Việt"; // NFC -- as a Vietnamese keyboard/IME produces it
    const decomposed = composed.normalize("NFD"); // base letters + combining diacritical marks
    expect(decomposed).not.toBe(composed); // sanity: these really are two different byte sequences
    expect(normaliseVietnamese(decomposed)).toBe(normaliseVietnamese(composed));
    expect(normaliseVietnamese(decomposed)).toBe("Tiếng Việt");
  });

  it("collapses runs of internal and surrounding whitespace", () => {
    expect(normaliseVietnamese("  Xin   chào   thế giới  ")).toBe("Xin chào thế giới");
  });
});
