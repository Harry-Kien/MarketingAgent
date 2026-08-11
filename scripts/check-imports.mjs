import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { findJsRelativeImports } from "./import-guard.mjs";

const files = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(ts|tsx|mts)$/.test(f));

let failed = false;
for (const file of files) {
  for (const hit of findJsRelativeImports(readFileSync(file, "utf8"))) {
    console.error(
      `${file}: relative import "${hit}" must use .ts — .js only resolves under tsc and vitest, not Turbopack or node --experimental-strip-types`,
    );
    failed = true;
  }
}

console.log(failed ? "import guard FAILED" : `import guard ok (${files.length} files)`);
process.exit(failed ? 1 : 0);
