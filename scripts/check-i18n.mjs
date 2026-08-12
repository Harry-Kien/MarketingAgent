import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { findHardcodedVietnamese } from "./i18n-guard.mjs";

function walk(dir) {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
}

const ROOT = "apps/web/src";
const I18N_DIR = join(ROOT, "i18n") + sep;

let failed = false;
for (const file of walk(ROOT)) {
  if (file.startsWith(I18N_DIR)) continue; // the message catalogue itself is Vietnamese by definition
  const src = readFileSync(file, "utf8");
  for (const v of findHardcodedVietnamese(src)) {
    console.error(`${file}: hard-coded Vietnamese string outside the i18n layer (ADR-006): "${v}"`);
    failed = true;
  }
}
console.log(failed ? "i18n guard FAILED" : "i18n ok");
process.exit(failed ? 1 : 0);
