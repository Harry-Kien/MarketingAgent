import { describe, expect, it } from "vitest";
import { tokens, toCssVars } from "./tokens.ts";

describe("ADR-008 C1 line-height floor", () => {
  it("has no line-height below 1.3", () => {
    for (const [name, value] of Object.entries(tokens.lineHeight)) {
      expect(value, `lineHeight.${name}`).toBeGreaterThanOrEqual(1.3);
    }
  });
  it("sets heading to exactly the measured safe minimum", () => {
    expect(tokens.lineHeight.heading).toBe(1.3);
  });
});

describe("palette", () => {
  it("defines light and dark for every colour role", () => {
    expect(Object.keys(tokens.color.light).sort()).toEqual(Object.keys(tokens.color.dark).sort());
  });
  it("uses the approved cham accent in light mode", () => {
    expect(tokens.color.light.cham).toBe("#29406B");
  });
  it("does not reuse the light accent in dark mode", () => {
    expect(tokens.color.dark.cham).not.toBe(tokens.color.light.cham);
  });
});

describe("geometry", () => {
  it("caps border radius at 6px", () => {
    for (const v of Object.values(tokens.radius)) expect(v).toBeLessThanOrEqual(6);
  });
  it("uses a 4px spacing scale", () => {
    for (const v of tokens.space) expect(v % 4).toBe(0);
  });
});

describe("toCssVars", () => {
  it("emits custom properties for the requested mode", () => {
    const css = toCssVars("dark");
    expect(css).toContain("--color-cham: #7C9BD1");
    expect(css).toContain("--lh-heading: 1.3");
  });
});
