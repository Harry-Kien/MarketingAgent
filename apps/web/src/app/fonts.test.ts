import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ADR-008 declared `--font-display: 'Archivo', ...` and `--font-body: 'Be
// Vietnam Pro', ...` in tokens.ts, but neither webfont was ever loaded --
// every page silently rendered in the system-ui fallback. This test fails
// before fonts.css exists (or before globals.css imports it, or before the
// referenced files are actually vendored) and passes once the fonts are
// really wired in, offline, from files committed to the repo.

const APP_DIR = resolve(import.meta.dirname); // apps/web/src/app
const PUBLIC_DIR = resolve(APP_DIR, "../../public");
const globalsCss = readFileSync(resolve(APP_DIR, "globals.css"), "utf8");
const fontsCssPath = resolve(APP_DIR, "fonts.css");

describe("webfont loading (ADR-008)", () => {
  it("globals.css imports fonts.css", () => {
    expect(globalsCss).toMatch(/@import\s+["']\.\/fonts\.css["'];?/);
  });

  it("fonts.css exists and is not empty", () => {
    expect(existsSync(fontsCssPath)).toBe(true);
    const css = readFileSync(fontsCssPath, "utf8");
    expect(css.length).toBeGreaterThan(0);
  });

  const fontsCss = existsSync(fontsCssPath) ? readFileSync(fontsCssPath, "utf8") : "";

  it("declares @font-face for Archivo at weights 400 and 700 (the weights globals.css actually requests)", () => {
    for (const weight of [400, 700]) {
      const re = new RegExp(
        `font-family:\\s*["']Archivo["'];[\\s\\S]*?font-weight:\\s*${weight};`,
      );
      expect(fontsCss, `Archivo weight ${weight}`).toMatch(re);
    }
  });

  it("declares @font-face for Be Vietnam Pro at weights 400 and 700", () => {
    for (const weight of [400, 700]) {
      const re = new RegExp(
        `font-family:\\s*["']Be Vietnam Pro["'];[\\s\\S]*?font-weight:\\s*${weight};`,
      );
      expect(fontsCss, `Be Vietnam Pro weight ${weight}`).toMatch(re);
    }
  });

  it("covers both the latin and vietnamese subsets for every declared face (this is a Vietnamese-language product)", () => {
    const blocks = fontsCss.split("@font-face").slice(1);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      // Every unicode-range in this file is one of the two subsets this
      // product needs: the vietnamese-subset block always includes
      // U+1EA0-1EF9 (precomposed vowel+tone letters); the latin-subset block
      // always includes U+0000-00FF (ASCII + Latin-1). A block missing both
      // markers would mean a subset (e.g. latin-ext) crept back in, which is
      // exactly the unnecessary-payload regression this guards against.
      const isVietnameseSubset = block.includes("U+1EA0-1EF9");
      const isLatinSubset = block.includes("U+0000-00FF");
      expect(isVietnameseSubset || isLatinSubset, block.slice(0, 120)).toBe(true);
    }
  });

  it("never references a subset other than latin or vietnamese (payload discipline)", () => {
    expect(fontsCss).not.toMatch(/U\+0100-02BA/); // latin-ext's signature range
  });

  it("every src url() in fonts.css points at a font file actually vendored under public/", () => {
    const urls = [...fontsCss.matchAll(/url\("(\/fonts\/[^"]+\.woff2)"\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThanOrEqual(8); // 2 families x 2 weights x 2 subsets
    for (const url of urls) {
      const filePath = resolve(PUBLIC_DIR, `.${url}`);
      expect(existsSync(filePath), `${url} -> ${filePath}`).toBe(true);
    }
  });

  it("vendors an SIL OFL license file next to each font family", () => {
    for (const dir of ["archivo", "be-vietnam-pro"]) {
      const licensePath = resolve(PUBLIC_DIR, "fonts", dir, "OFL.txt");
      expect(existsSync(licensePath), licensePath).toBe(true);
      const text = readFileSync(licensePath, "utf8");
      expect(text).toContain("SIL OPEN FONT LICENSE");
    }
  });
});
