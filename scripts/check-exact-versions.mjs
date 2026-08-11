import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { findForbiddenDeps, findRangeVersions } from "./guards.mjs";

const files = globSync(["package.json", "apps/*/package.json", "packages/*/package.json"]);

let failed = false;
for (const file of files) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  for (const hit of findRangeVersions(pkg)) {
    console.error(`${file}: range version ${hit} (ADR: pin exact)`);
    failed = true;
  }
  for (const hit of findForbiddenDeps(pkg)) {
    console.error(`${file}: forbidden dependency ${hit}`);
    failed = true;
  }
}

console.log(failed ? "version guard FAILED" : `version guard ok (${files.length} manifests)`);
process.exit(failed ? 1 : 0);
