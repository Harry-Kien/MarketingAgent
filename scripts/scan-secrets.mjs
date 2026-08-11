import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /xox[baprs]-/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /EAA[A-Za-z0-9]{40,}/,
  /[0-9]{9,10}:AA[A-Za-z0-9_-]{33}/,
];

const TEXT = /\.(ts|tsx|js|mjs|json|md|yml|yaml|sql|html|css)$/;

// Test fixtures deliberately contain secret-shaped strings; they are the point
// of the test. Everything else must be clean.
const EXEMPT = /\.test\.(ts|tsx|mjs)$|scan-secrets\.mjs$|injection-payloads\.ts$/;

const files = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && TEXT.test(f) && !EXEMPT.test(f));

let failed = false;
for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const pattern of PATTERNS) {
    if (pattern.exec(content)) {
      console.error(`${file}: possible secret matching ${pattern}`);
      failed = true;
    }
  }
}

console.log(failed ? "secret scan FAILED" : `secret scan ok (${files.length} files)`);
process.exit(failed ? 1 : 0);
