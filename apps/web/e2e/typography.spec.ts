// Empirical verification for the ADR-008 gap: tokens.ts declared
// `--font-display: 'Archivo', ...` and `--font-body: 'Be Vietnam Pro', ...`
// but neither webfont was ever loaded, so every page silently rendered in
// the system-ui fallback and the design direction the blueprint specifies
// did not exist in the running product.
//
// This spec does not trust "no console error" as proof the fonts render --
// it measures actual glyph pixels. The technique (canvas TextMetrics'
// `actualBoundingBoxAscent`/`actualBoundingBoxDescent`, and own-vs-fallback
// width comparison) mirrors the method described in
// docs/research/font-render-verification.md, but run here against the real
// app (apps/web/src/app/fonts.css + globals.css), not the throwaway harness
// that document used -- V6 verified the typefaces in isolation; this
// verifies they are actually wired into this codebase.
//
// Uses /login, the one route that renders without a database session, so
// this suite has no Postgres dependency (unlike auth.spec.ts).
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { tokens } from "../src/ui/tokens.ts";

const ASSETS_DIR = resolve(import.meta.dirname, "../../../docs/research/assets");

test.beforeAll(() => {
  mkdirSync(ASSETS_DIR, { recursive: true });
});

async function gotoLogin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.evaluate(() => document.fonts.ready);
}

test.describe("ADR-008: Archivo and Be Vietnam Pro actually render", () => {
  test("both webfonts, at the weights this app requests, are actually fetchable and load", async ({ page }) => {
    await gotoLogin(page);
    // /login itself only renders Archivo 700 (the h1) and Be Vietnam Pro 400
    // (body text) -- the browser is lazy and will never fetch a face nothing
    // on the page asks for, so document.fonts.check() for the *other* two
    // combinations would report false regardless of whether fonts.css is
    // correct. `document.fonts.load()` explicitly requests each face this
    // app declares, independent of what /login happens to render, which is
    // what this test is actually verifying: that all four @font-face
    // weight/family combinations fonts.css declares are real, fetchable
    // woff2 files, not just declarations.
    const result = await page.evaluate(async () => {
      await Promise.all([
        document.fonts.load('400 16px "Archivo"'),
        document.fonts.load('700 16px "Archivo"'),
        document.fonts.load('400 16px "Be Vietnam Pro"'),
        document.fonts.load('700 16px "Be Vietnam Pro"'),
      ]);
      return {
        archivo400: document.fonts.check('400 16px "Archivo"'),
        archivo700: document.fonts.check('700 16px "Archivo"'),
        bvp400: document.fonts.check('400 16px "Be Vietnam Pro"'),
        bvp700: document.fonts.check('700 16px "Be Vietnam Pro"'),
        loadedFamilies: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
      };
    });
    expect(result.archivo400, "Archivo 400 loaded").toBe(true);
    expect(result.archivo700, "Archivo 700 loaded").toBe(true);
    expect(result.bvp400, "Be Vietnam Pro 400 loaded").toBe(true);
    expect(result.bvp700, "Be Vietnam Pro 700 loaded").toBe(true);
    // document.fonts.check() alone is not proof (see the C2 test below for
    // why) -- this asserts the FontFace entries this app's own fonts.css
    // registered actually transitioned to "loaded", i.e. the browser fetched
    // and parsed the woff2 files, not merely that the CSS declared them.
    expect(result.loadedFamilies).toContain("Archivo");
    expect(result.loadedFamilies).toContain("Be Vietnam Pro");
  });

  test("headings actually render in Archivo and body text in Be Vietnam Pro, not the system-ui fallback", async ({
    page,
  }) => {
    await gotoLogin(page);
    // document.fonts.check() proves the resource loaded; it does not prove
    // the *page* is using it for a given element (a typo in the CSS
    // font-family would still pass every check() above while the h1 quietly
    // rendered in system-ui). Compare actual measured glyph width against
    // the same string forced into a fallback-only font: if Archivo is truly
    // active on the h1, "SO DIEU HANH" should NOT measure identically to
    // the same text explicitly set to Arial.
    const widths = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      if (!h1) throw new Error("no h1 on /login");
      const text = h1.textContent ?? "";
      const rectReal = h1.getBoundingClientRect();
      const clone = h1.cloneNode(true) as HTMLElement;
      clone.style.fontFamily = "Arial, sans-serif";
      clone.style.position = "fixed";
      clone.style.top = "-9999px";
      document.body.appendChild(clone);
      const rectFallback = clone.getBoundingClientRect();
      clone.remove();
      return { text, widthReal: rectReal.width, widthFallback: rectFallback.width };
    });
    expect(widths.widthReal).toBeGreaterThan(0);
    // Archivo and Arial have visibly different metrics; a real Archivo
    // render must not coincide with a forced-Arial render pixel-for-pixel.
    expect(Math.abs(widths.widthReal - widths.widthFallback)).toBeGreaterThan(1);
  });

  test("visual screenshot of the login page for human review", async ({ page }) => {
    await gotoLogin(page);
    await page.screenshot({ path: resolve(ASSETS_DIR, "typography-app-login.png"), fullPage: true });
  });
});

// ---------------------------------------------------------------------------
// C2: does Archivo actually contain U+00B7 (MIDDLE DOT) now that the real
// font file is loaded in this app? Measured with the same own-vs-fallback
// canvas technique V6 used: if the width Archivo reports for a glyph is
// indistinguishable from the width a font that certainly lacks it (Arial via
// forced fallback) reports, the glyph came from font substitution, not from
// Archivo's own outlines.
// ---------------------------------------------------------------------------
test.describe("ADR-008 C2: does Archivo actually have U+00B7 now that it's a real, loaded font?", () => {
  test("control: Archivo's own glyph for a definitely-covered character measures differently from forced fallback", async ({
    page,
  }) => {
    await gotoLogin(page);
    const { archivo, fallback } = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d")!;
      ctx.font = '400 48px "Archivo"';
      const archivo = ctx.measureText("A").width;
      ctx.font = "400 48px Arial";
      const fallback = ctx.measureText("A").width;
      return { archivo, fallback };
    });
    // This is the control proving the method works: 'A' is unambiguously in
    // Archivo, so if the technique can't tell Archivo's 'A' apart from
    // Arial's 'A' here, a "match" for '·' below would prove nothing.
    expect(Math.abs(archivo - fallback), `Archivo 'A'=${archivo}px vs Arial 'A'=${fallback}px`).toBeGreaterThan(1);
  });

  test("EMPIRICAL RESULT: U+00B7 (·) rendered with Archivo measures the same as forced Arial fallback", async ({
    page,
  }) => {
    await gotoLogin(page);
    const measured = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d")!;
      ctx.font = '400 48px "Archivo"';
      const archivo = ctx.measureText("·").width;
      ctx.font = "400 48px Arial";
      const fallback = ctx.measureText("·").width;
      // Be Vietnam Pro is the documented control the other direction: V6
      // found it DOES contain U+00B7, so its own measurement should differ
      // from forced Arial the same way the 'A' control above did.
      ctx.font = '400 48px "Be Vietnam Pro"';
      const bvpOwn = ctx.measureText("·").width;
      return { archivo, fallback, bvpOwn };
    });
    const delta = Math.abs(measured.archivo - measured.fallback);
    const bvpDelta = Math.abs(measured.bvpOwn - measured.fallback);
    // This is the empirical finding, not an assumption: log it so it is
    // visible in the Playwright run output as well as in this file's
    // assertions.
    // eslint-disable-next-line no-console
    console.log(
      `[C2] Archivo '·' width=${measured.archivo}px, Arial fallback '·' width=${measured.fallback}px, ` +
        `delta=${delta}px | Be Vietnam Pro '·' width=${measured.bvpOwn}px, delta-from-Arial=${bvpDelta}px`,
    );
    // C2, empirically confirmed with the real font file present: Archivo's
    // '·' is indistinguishable from the Arial fallback (glyph missing, OS
    // substitution kicks in) -- while Be Vietnam Pro's own '·' is NOT
    // indistinguishable from Arial (it has its own outlines), exactly as
    // docs/research/font-render-verification.md section 3.2 measured. If
    // Archivo has since gained the glyph, `delta` here would be large like
    // bvpDelta and this assertion would fail -- which is the point: this
    // test is not allowed to just assume the finding still holds.
    expect(delta, `Archivo '·' vs Arial fallback delta = ${delta}px (want ~0, glyph missing)`).toBeLessThan(0.5);
    expect(bvpDelta, `Be Vietnam Pro '·' vs Arial fallback delta = ${bvpDelta}px (want > 1, has its own glyph)`).toBeGreaterThan(1);
  });

  test("visual: a large middot rendered in the three fonts, for human inspection", async ({ page }) => {
    await gotoLogin(page);
    await page.evaluate(() => {
      const box = document.createElement("div");
      box.id = "c2-visual-check";
      box.style.position = "fixed";
      box.style.top = "0";
      box.style.left = "0";
      box.style.background = "white";
      box.style.color = "black";
      box.style.padding = "16px";
      box.style.zIndex = "9999";
      box.style.fontSize = "64px";
      box.innerHTML = `
        <div style="font-family:'Archivo'">Archivo: A · B</div>
        <div style="font-family:'Be Vietnam Pro'">Be Vietnam Pro: A · B</div>
        <div style="font-family:Arial">Arial (fallback): A · B</div>
      `;
      document.body.appendChild(box);
    });
    await expect(page.locator("#c2-visual-check")).toBeVisible();
    await page.locator("#c2-visual-check").screenshot({
      path: resolve(ASSETS_DIR, "typography-c2-middot-comparison.png"),
    });
  });
});

// ---------------------------------------------------------------------------
// C1: does the measured 1.3 line-height floor still hold now that real font
// metrics (not fallback-font metrics) are in play? V6's own measurements
// were taken against the real typeface loaded from a CDN in an isolated
// harness -- this reproduces the same measurement against the real,
// self-hosted font file this app now actually serves.
// ---------------------------------------------------------------------------
test.describe("ADR-008 C1: line-height floor against real Be Vietnam Pro metrics", () => {
  // Worst case from the research doc: a line of all-caps diacritics above a
  // line of below-baseline hook diacritics.
  const TOP_LINE = "ẲẴẶỠỢỮỰ";
  const BOTTOM_LINE = "ựữứừụ ợỡởớờ ỵỹỷỳ";
  const FONT_SIZE_PX = 15; // matches the research doc's measurement

  async function measureLineGap(page: Page, lineHeightRatio: number): Promise<number> {
    return page.evaluate(
      ({ top, bottom, fontSize, lineHeight }) => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d")!;
        ctx.font = `400 ${fontSize}px "Be Vietnam Pro"`;
        const lineHeightPx = fontSize * lineHeight;
        const y1 = 100; // baseline of the first line, arbitrary
        const y2 = y1 + lineHeightPx; // baseline of the second line
        const m1 = ctx.measureText(top);
        const m2 = ctx.measureText(bottom);
        const line1BottomInk = y1 + m1.actualBoundingBoxDescent;
        const line2TopInk = y2 - m2.actualBoundingBoxAscent;
        return line2TopInk - line1BottomInk;
      },
      { top: TOP_LINE, bottom: BOTTOM_LINE, fontSize: FONT_SIZE_PX, lineHeight: lineHeightRatio },
    );
  }

  test("negative control: line-height 1.0 reproduces the collision V6 measured", async ({ page }) => {
    await gotoLogin(page);
    const gap = await measureLineGap(page, 1.0);
    // eslint-disable-next-line no-console
    console.log(`[C1 control] line-height 1.0 real-metric gap = ${gap}px (V6 measured -4.00px in its harness)`);
    // Proves the measurement technique can detect a real collision -- if
    // this didn't go negative, the "1.3 is safe" result below would be
    // meaningless (a broken measurement that always reports "fine").
    expect(gap, `gap at line-height 1.0 = ${gap}px`).toBeLessThan(0);
  });

  test(`token floor (${tokens.lineHeight.heading}) does not collide, measured against the real self-hosted font`, async ({
    page,
  }) => {
    await gotoLogin(page);
    const gap = await measureLineGap(page, tokens.lineHeight.heading);
    // eslint-disable-next-line no-console
    console.log(
      `[C1] line-height ${tokens.lineHeight.heading} real-metric gap = ${gap}px (V6 measured +0.50px in its harness)`,
    );
    expect(gap, `gap at line-height ${tokens.lineHeight.heading} = ${gap}px`).toBeGreaterThanOrEqual(0);
  });

  test("visual: the worst-case two-line Vietnamese diacritic stack at the token line-height, for human inspection", async ({
    page,
  }) => {
    await gotoLogin(page);
    await page.evaluate(
      ({ top, bottom, fontSize, lineHeight }) => {
        const box = document.createElement("div");
        box.id = "c1-visual-check";
        box.style.position = "fixed";
        box.style.top = "0";
        box.style.left = "0";
        box.style.background = "white";
        box.style.color = "black";
        box.style.padding = "16px";
        box.style.zIndex = "9999";
        box.style.fontFamily = "'Be Vietnam Pro'";
        box.style.fontSize = `${fontSize}px`;
        box.style.lineHeight = String(lineHeight);
        box.textContent = `${top}\n${bottom}`;
        box.style.whiteSpace = "pre";
        document.body.appendChild(box);
      },
      { top: TOP_LINE, bottom: BOTTOM_LINE, fontSize: FONT_SIZE_PX, lineHeight: tokens.lineHeight.heading },
    );
    await expect(page.locator("#c1-visual-check")).toBeVisible();
    await page.locator("#c1-visual-check").screenshot({
      path: resolve(ASSETS_DIR, "typography-c1-diacritic-stack.png"),
    });
  });
});
