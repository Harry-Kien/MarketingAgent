import { describe, expect, it } from "vitest";
import { findLineHeightViolations, findArchivoMiddot, findBannedVisuals } from "./design-constraints.mjs";

// Built via fromCharCode rather than typed as a literal escape sequence in
// this file, because a literal `·` typed here would itself be resolved
// by the JS parser loading THIS test file, defeating the point: we need the
// six raw characters backslash-u-0-0-b-7, matching what a real .tsx source
// file contains when a developer types that escape in their own JSX string.
const LITERAL_BACKSLASH_U00B7 = String.fromCharCode(92) + "u00b7";

describe("C1 line-height", () => {
  it("flags a value below 1.3", () => {
    expect(findLineHeightViolations(`.x { line-height: 1.2; }`)).toEqual(["1.2"]);
    expect(findLineHeightViolations(`className="leading-[1.1]"`)).toEqual(["1.1"]);
  });
  it("allows 1.3 and above", () => {
    expect(findLineHeightViolations(`.x { line-height: 1.3; } .y { line-height: 1.5; }`)).toEqual([]);
  });
  it("ignores unitless 1 used for other properties", () => {
    expect(findLineHeightViolations(`.x { flex-grow: 1; }`)).toEqual([]);
  });
});

describe("C2 middot in Archivo", () => {
  it("flags a middot inside a display-font element", () => {
    const src = `<span className="font-display">Đã đăng · Bị chặn</span>`;
    expect(findArchivoMiddot(src)).toHaveLength(1);
  });
  it("allows a middot in body text", () => {
    expect(findArchivoMiddot(`<span className="font-body">a · b</span>`)).toEqual([]);
  });
});

describe("anti AI-look", () => {
  it("flags neon gradients and glassmorphism", () => {
    expect(findBannedVisuals(`background: linear-gradient(90deg,#0ff,#f0f);`)).toContain("gradient");
    expect(findBannedVisuals(`backdrop-filter: blur(12px);`)).toContain("backdrop-filter");
  });
  it("flags an oversized border radius", () => {
    expect(findBannedVisuals(`border-radius: 24px;`)).toContain("border-radius: 24px");
  });
  it("allows radius up to 6px", () => {
    expect(findBannedVisuals(`border-radius: 6px;`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1: the original suite above locked each guard with a single
// assertion, so a guard that only caught one shape of violation still passed
// it. These tables enumerate every evasion form the reviewer found (plus the
// forms that must keep passing) so gutting the guard breaks many tests, not
// one.
// ---------------------------------------------------------------------------

describe("C1 line-height -- violation table (must all be flagged)", () => {
  const cases = [
    ["bare CSS line-height below floor", `.x { line-height: 1.2; }`],
    ["tailwind arbitrary leading-[]", `className="leading-[1.1]"`],
    ["tailwind leading-tight (1.25)", `className="leading-tight"`],
    ["tailwind leading-none (1)", `className="leading-none"`],
    ["React inline style lineHeight", `style={{ lineHeight: 1.1 }}`],
    ["CSS custom property --lh-*", `:root { --lh-x: 1.1; }`],
    ["CSS custom property *line-height*", `:root { --heading-line-height: 1.1; }`],
    ["calc() wrapper", `.x { line-height: calc(1.1); }`],
    ["font shorthand ratio after the slash", `.x { font: 700 14px/1.1 Archivo; }`],
    ["uppercase property name", `.x { LINE-HEIGHT: 1.1; }`],
    ["whitespace before the colon", `.x { line-height : 1.1; }`],
    ["absolute px unit (ratio unresolvable, refused outright)", `.x { line-height: 20px; }`],
    ["absolute rem unit (ratio unresolvable, refused outright)", `.x { line-height: 1.2rem; }`],
  ];
  for (const [name, src] of cases) {
    it(`flags: ${name}`, () => {
      expect(findLineHeightViolations(src).length, src).toBeGreaterThan(0);
    });
  }
});

describe("C1 line-height -- legitimate table (must never be flagged)", () => {
  const cases = [
    ["exactly the floor and above", `.x { line-height: 1.3; } .y { line-height: 1.5; }`],
    ["unrelated unitless property", `.x { flex-grow: 1; }`],
    ["React inline style at the floor", `style={{ lineHeight: 1.5 }}`],
    ["tailwind leading-normal (1.5)", `className="leading-normal"`],
    ["tailwind leading-snug (1.375)", `className="leading-snug"`],
    ["tailwind leading-loose (2)", `className="leading-loose"`],
    ["CSS custom property at the floor", `:root { --lh-body: 1.5; }`],
    ["font shorthand ratio at the floor", `.x { font: 700 14px/1.5 Archivo; }`],
  ];
  for (const [name, src] of cases) {
    it(`allows: ${name}`, () => {
      expect(findLineHeightViolations(src), src).toEqual([]);
    });
  }
});

describe("C2 middot -- violation table (must all be flagged)", () => {
  const cases = [
    ["literal middot, direct child", `<span className="font-display">Đã đăng · Bị chặn</span>`],
    ["nested child under a font-display ancestor", `<div className="font-display"><span>Đã đăng · Bị chặn</span></div>`],
    ["named HTML entity", `<span className="font-display">Đã đăng &middot; Bị chặn</span>`],
    ["decimal numeric entity", `<span className="font-display">Đã đăng &#183; Bị chặn</span>`],
    ["hex numeric entity", `<span className="font-display">Đã đăng &#xB7; Bị chặn</span>`],
    ["lowercase hex numeric entity", `<span className="font-display">Đã đăng &#xb7; Bị chặn</span>`],
    ["JS unicode escape \\u00b7 (literal 6 chars in source, resolves to the glyph at runtime)", `<span className="font-display">Da dang {"${LITERAL_BACKSLASH_U00B7}"} Bi chan</span>`],
    ["lookalike bullet U+2022", `<span className="font-display">Đã đăng • Bị chặn</span>`],
    ["lookalike dot operator U+22C5", `<span className="font-display">Đã đăng ⋅ Bị chặn</span>`],
    ["lookalike bullet operator U+2219", `<span className="font-display">Đã đăng ∙ Bị chặn</span>`],
  ];
  for (const [name, src] of cases) {
    it(`flags: ${name}`, () => {
      expect(findArchivoMiddot(src).length, src).toBeGreaterThan(0);
    });
  }
});

describe("C2 middot -- legitimate table (must never be flagged)", () => {
  const cases = [
    ["middot in body-font text", `<span className="font-body">a · b</span>`],
    ["nested override to font-body escapes the display ancestor", `<div className="font-display"><span className="font-body">a · b</span></div>`],
    ["em-dash separator, the approved substitute", `<span className="font-display">Đã đăng — Bị chặn</span>`],
    ["middot in mono-font text", `<span className="font-mono">12:30 · 45.000.000</span>`],
    ["no separator at all", `<span className="font-display">Đã đăng Bị chặn</span>`],
  ];
  for (const [name, src] of cases) {
    it(`allows: ${name}`, () => {
      expect(findArchivoMiddot(src), src).toEqual([]);
    });
  }
});

describe("C2 middot -- messages name which rule was broken", () => {
  it("the strict C2 glyph rule and the anti-generic lookalike rule produce distinguishable messages", () => {
    const strict = findArchivoMiddot(`<span className="font-display">a · b</span>`);
    const lookalike = findArchivoMiddot(`<span className="font-display">a • b</span>`);
    expect(strict[0].rule).toMatch(/U\+00B7/i);
    expect(lookalike[0].rule).toMatch(/lookalike|generic/i);
    expect(strict[0].rule).not.toEqual(lookalike[0].rule);
  });
});

describe("anti AI-look -- still fires on a real violation and still passes clean input", () => {
  it("rejects a deliberately violating block", () => {
    const hits = findBannedVisuals(`background: linear-gradient(90deg,#0ff,#f0f); backdrop-filter: blur(8px); border-radius: 12px;`);
    expect(hits.length).toBeGreaterThan(0);
  });
  it("passes a clean block", () => {
    expect(findBannedVisuals(`background: var(--color-surface); border-radius: 6px;`)).toEqual([]);
  });
});
