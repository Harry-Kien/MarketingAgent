import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findQualityScoreAuthz } from "./authz-purity.mjs";

// Deliberately walks the real filesystem rather than enumerating via
// `git ls-files` (the convention most other guards in this repo use, e.g.
// check-domain-purity.mjs) -- proved necessary, not stylistic, by this
// task's own required adversarial check (task-12-brief.md step 4): a
// freshly-written violation is untracked (never `git add`ed) at exactly the
// moment this guard needs to catch it, so a git-ls-files-based version
// would report the repository clean while a real violation sat right next
// to it on disk. Reproduced live during self-review: the git-ls-files
// version of this file printed "authz purity ok" with an unstaged
// `qualityScore >= 80` gate sitting in packages/policy/src/tmp-bad.ts.
// None of the four specified roots contain a nested `dist/` or
// `node_modules/` (each is a package's `src/` directory or
// infra/migrations, and `dist/` is always a sibling of `src/`, never
// inside it), so a plain recursive walk cannot accidentally pick up a
// compiled duplicate the way it could if a root were a package directory.
function walk(dir) {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx|sql)$/.test(p) && !/\.test\.ts$/.test(p) ? [p] : [];
  });
}

const roots = [
  "packages/domain/src",
  "packages/policy/src",
  "packages/agents/src",
  "packages/db/src",
  "infra/migrations",
];

const files = roots.flatMap((root) => walk(root));

let failed = false;
for (const file of files) {
  for (const hit of findQualityScoreAuthz(readFileSync(file, "utf8"))) {
    console.error(`${file}: quality_score used in a condition -> "${hit}" (invariant 4: quality never grants permission)`);
    failed = true;
  }
}

console.log(failed ? "authz purity FAILED" : `authz purity ok (${files.length} files)`);
process.exit(failed ? 1 : 0);
