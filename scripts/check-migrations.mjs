import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { collectFileFacts, computeViolations } from "./migration-guards.mjs";

const dir = "infra/migrations";
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

// Each file is parsed in complete isolation — collectFileFacts never sees text
// from more than one file, so a malformed file can never hide a table defined
// in a later file. Facts are aggregated as data (table names, workspace_id
// flags, RLS-enabled names), never by concatenating SQL text.
const fileFacts = files.map((name) => ({
  name,
  facts: collectFileFacts(readFileSync(join(dir, name), "utf8")),
}));

const { tenancyViolations, rlsViolations, unparseableFiles } = computeViolations(fileFacts);

let failed = false;

for (const { file, construct } of unparseableFiles) {
  console.error(`migration: ${file} cannot be certified — ${construct} (D1-0)`);
  failed = true;
}
for (const name of tenancyViolations) {
  console.error(`migration: table "${name}" is workspace-owned but has no workspace_id (D1-1)`);
  failed = true;
}
for (const name of rlsViolations) {
  console.error(`migration: table "${name}" does not ENABLE ROW LEVEL SECURITY (D1-2)`);
  failed = true;
}

console.log(failed ? "migration guard FAILED" : `migration guard ok (${files.length} files)`);
process.exit(failed ? 1 : 0);
