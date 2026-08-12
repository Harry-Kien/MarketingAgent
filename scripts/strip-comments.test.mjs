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

// ---------------------------------------------------------------------------
// Fix round 3: the `(?<!:)` lookbehind only guarded the ONE character before
// `//`, so a `//` anywhere inside a plain double/single-quoted string or
// template literal -- not just after a URL scheme's `:` -- was still
// misread as a comment start, blanking the rest of the line: every
// attribute after it on that line, not just the string containing `//`.
// The fix scans string literals verbatim (respecting escapes) so nothing
// inside them is ever mistaken for a comment, regardless of what precedes
// the `//`.
// ---------------------------------------------------------------------------
describe("stripComments -- // is only a comment OUTSIDE a string literal (fix round 3)", () => {
  it("does not blank // inside a double-quoted string not preceded by a URL scheme", () => {
    const src = `placeholder="Giá // 100" aria-label="Huỷ"`;
    expect(stripComments(src)).toBe(src);
  });
  it("does not blank // inside a href URL, and content after it on the line survives", () => {
    const src = `<a href="https://example.com" aria-label="Mở trang chiến dịch">`;
    expect(stripComments(src)).toBe(src);
  });
  it("does not blank // inside a single-quoted string", () => {
    const src = `const x = 'a // b';`;
    expect(stripComments(src)).toBe(src);
  });
  it("does not blank // inside a template literal", () => {
    const src = "const x = `a // b`;";
    expect(stripComments(src)).toBe(src);
  });
  it("does not blank // inside a string within a JSX attribute expression", () => {
    const src = `<a href={"https://example.com"} aria-label="Mở trang">`;
    expect(stripComments(src)).toBe(src);
  });
  it("does not blank // inside a src URL", () => {
    const src = `<img src="https://example.com/logo.svg" alt="Logo chiến dịch" />`;
    expect(stripComments(src)).toBe(src);
  });
  it("still blanks a genuine // comment outside any string, Vietnamese included", () => {
    const src = "const x = 1; // comment chứa tiếng Việt\nconst y = 2;";
    const out = stripComments(src);
    expect(out).not.toContain("tiếng Việt");
    expect(out).toContain("const y = 2;");
  });
  it("still blanks a genuine // comment that follows code containing a string", () => {
    const src = `const x = "safe"; // real comment · here\nconst y = 2;`;
    const out = stripComments(src);
    expect(out).toContain(`"safe"`);
    expect(out).not.toContain("·");
    expect(out).toContain("const y = 2;");
  });
});

describe("stripComments -- /* */ respects string boundaries too (fix round 3)", () => {
  it("does not blank /* */ -shaped text inside a string literal", () => {
    const src = `placeholder="Xem /* chi tiết */ ở đây"`;
    expect(stripComments(src)).toBe(src);
  });
  it("still blanks a genuine block comment", () => {
    const src = `const x = 1; /* real · comment */ const y = 2;`;
    const out = stripComments(src);
    expect(out).not.toContain("·");
    expect(out).toContain("const y = 2;");
  });
});
