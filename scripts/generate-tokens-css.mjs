// Regenerates apps/web/src/ui/tokens.css from apps/web/src/ui/tokens.ts, the
// single source of truth (Task 1). Run after any edit to tokens.ts:
//   node scripts/generate-tokens-css.mjs
import { writeFileSync } from "node:fs";
import { toCssVars } from "../apps/web/src/ui/tokens.ts";

const css = `/* GENERATED FILE — do not edit by hand.
 * Source: apps/web/src/ui/tokens.ts
 * Regenerate: node scripts/generate-tokens-css.mjs
 */
:root {
${toCssVars("light")}
}

[data-theme="dark"] {
${toCssVars("dark")}
}
`;

writeFileSync(new URL("../apps/web/src/ui/tokens.css", import.meta.url), css);
console.log("wrote apps/web/src/ui/tokens.css");
