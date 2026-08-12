import { describe, expect, it } from "vitest";
import { findLineHeightViolations, findArchivoMiddot, findBannedVisuals } from "./design-constraints.mjs";

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
