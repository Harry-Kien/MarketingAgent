import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findArchivoMiddot, findBannedVisuals, findLineHeightViolations } from "./design-constraints.mjs";

function walk(dir) {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx|css)$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
}

let failed = false;
for (const file of walk("apps/web/src")) {
  const src = readFileSync(file, "utf8");
  for (const v of findLineHeightViolations(src)) { console.error(`${file}: line-height ${v} is below the 1.3 floor (ADR-008 C1)`); failed = true; }
  for (const v of findArchivoMiddot(src)) { console.error(`${file}: middot inside display font (ADR-008 C2): ${v}`); failed = true; }
  for (const v of findBannedVisuals(src)) { console.error(`${file}: banned visual "${v}" (blueprint 9)`); failed = true; }
}
console.log(failed ? "design constraints FAILED" : "design constraints ok");
process.exit(failed ? 1 : 0);
