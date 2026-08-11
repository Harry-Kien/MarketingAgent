import { execSync } from "node:child_process";
import { findForbiddenScope } from "./guards.mjs";

const tracked = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
const hits = findForbiddenScope(tracked);

for (const hit of hits) console.error(`out-of-scope path for M0/M1 (D1.b): ${hit}`);
console.log(hits.length ? "scope guard FAILED" : `scope guard ok (${tracked.length} files)`);
process.exit(hits.length ? 1 : 0);
