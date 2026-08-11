import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findTenancyViolations, findRlsViolations, stripComments } from "./migration-guards.mjs";

const dir = "infra/migrations";
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
// Strip comments from each file individually to prevent unterminated constructs
// in one file from affecting detection in another file, then join for cross-file checks
const all = files.map((f) => stripComments(readFileSync(join(dir, f), "utf8"))).join("\n");

let failed = false;
for (const name of findTenancyViolations(all)) { console.error(`migration: table "${name}" is workspace-owned but has no workspace_id (D1-1)`); failed = true; }
for (const name of findRlsViolations(all)) { console.error(`migration: table "${name}" does not ENABLE ROW LEVEL SECURITY (D1-2)`); failed = true; }
console.log(failed ? "migration guard FAILED" : `migration guard ok (${files.length} files)`);
process.exit(failed ? 1 : 0);
