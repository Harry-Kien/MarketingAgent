import { describe, expect, it } from "vitest";
import { computeContrastRatio, checkTokenContrast, checkKnownGaps } from "./check-contrast.mjs";

// @axe-core/playwright is not installed in this workspace (checked: absent
// from every package.json/package-lock.json in the repo) and the brief
// forbids adding a new dependency to a shared lockfile, so a real axe DOM
// scan is not available for this track's D10 evidence. This is a narrower,
// dependency-free substitute: the same WCAG 2.x relative-luminance contrast
// formula axe itself uses, run directly against tokens.ts's actual color
// values for every foreground/background pair the real UI renders (see
// check-contrast.mjs's CONTRAST_PAIRS, collected by grepping every `color:
// var(--color-*)` / `background: var(--color-*)` occurrence under
// apps/web/src). It proves contrast math on the tokens themselves; it does
// NOT prove every rendered DOM node resolves to exactly these pairs, nor
// does it check anything beyond contrast (axe covers far more of WCAG than
// this).

describe("computeContrastRatio", () => {
  it("returns 21:1 for pure black on pure white (the maximum possible ratio)", () => {
    expect(computeContrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
  });

  it("returns 1:1 for identical colors", () => {
    expect(computeContrastRatio("#445A78", "#445A78")).toBeCloseTo(1, 5);
  });

  it("is symmetric regardless of argument order", () => {
    const a = computeContrastRatio("#16181C", "#FBFBFA");
    const b = computeContrastRatio("#FBFBFA", "#16181C");
    expect(a).toBeCloseTo(b, 10);
  });
});

describe("checkTokenContrast", () => {
  it("finds zero AA failures across the confirmed-compliant token pairs, light and dark", () => {
    const failures = checkTokenContrast();
    expect(failures, JSON.stringify(failures, null, 2)).toHaveLength(0);
  });

  it("actually catches a real AA failure (adversarial: not a guard that always passes)", () => {
    // A same-color pair is a 1:1 ratio -- nothing could pass AA against
    // itself. If checkTokenContrast can't be made to fail with an obviously
    // broken pair, it isn't a real check. (Not tho-on-tho: tho is the one
    // real pair this file already knows is failing -- see checkKnownGaps
    // below -- so this probe uses ink-on-ink, a pair that IS in
    // CONTRAST_PAIRS's compliant list at its real value, to prove the
    // *function*, not to duplicate the real finding.)
    const failures = checkTokenContrast([{ mode: "light", fg: "ink", bg: "ink", label: "ink-on-ink (probe)" }]);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toMatch(/ink-on-ink \(probe\)/);
  });
});

describe("checkKnownGaps", () => {
  it("confirms the tho-on-paper AA gap is real and still unfixed (disclosed, not silently excluded)", () => {
    const [gap] = checkKnownGaps();
    expect(gap.stillFailing).toBe(true);
    expect(gap.ratio).toBeLessThan(4.5);
    expect(gap.ratio).toBeGreaterThan(4); // pins the current measured value (~4.04:1), not just "some" failure
  });
});
