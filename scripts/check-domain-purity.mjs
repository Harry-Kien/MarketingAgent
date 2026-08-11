import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { findImpureImports } from "./domain-purity.mjs";

const files = execSync("git ls-files packages/domain/src", { encoding: "utf8" })
  .split("\n")
  .filter((f) => f.endsWith(".ts"));

let failed = false;
for (const file of files) {
  for (const hit of findImpureImports(readFileSync(file, "utf8"))) {
    console.error(`${file}: domain must not import "${hit}" (ADR-002 M2)`);
    failed = true;
  }
}

console.log(failed ? "domain purity FAILED" : `domain purity ok (${files.length} files)`);
process.exit(failed ? 1 : 0);
