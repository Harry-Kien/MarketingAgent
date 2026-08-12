import { describe, expect, it } from "vitest";
import { stripComments } from "./strip-comments.mjs";

describe("stripComments", () => {
  it("blanks a JSX comment but preserves length and the surrounding braces", () => {
    const src = `<div>{/* hello */}</div>`;
    const out = stripComments(src);
    expect(out).toHaveLength(src.length);
    expect(out).not.toContain("hello");
    expect(out).toContain("<div>{");
    expect(out).toContain("}</div>");
  });
  it("blanks a // line comment to end of line, preserving the newline", () => {
    const src = "const x = 1; // uses · here\nconst y = 2;";
    const out = stripComments(src);
    expect(out).not.toContain("·");
    expect(out).toContain("const y = 2;");
    expect(out.split("\n")).toHaveLength(2);
  });
  it("does not treat :// inside a URL as a comment start", () => {
    const src = `href="https://example.com/path"`;
    expect(stripComments(src)).toBe(src);
  });
  it("blanks a multi-line block comment without merging surrounding lines", () => {
    const src = "a\n/* line1\nline2 */\nb";
    const out = stripComments(src);
    expect(out.split("\n")).toHaveLength(4);
    expect(out).not.toContain("line1");
  });
});
