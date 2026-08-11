/**
 * ADR-002 M2: packages/domain must not know how it is persisted or
 * rendered. Keeping the domain free of infrastructure imports is what keeps
 * the ORM choice reversible -- swapping Drizzle for something else must be a
 * change to one infrastructure layer, not a rewrite of the domain.
 */
const FORBIDDEN = ["drizzle-orm", "pg", "next", "react", "react-dom", "pg-boss", "@smos/db"];

// Same shape as scripts/import-guard.mjs's RELATIVE_JS_IMPORT: matches both
// `from "spec"` and `import(...)`/`import "spec"` forms in one pass.
const IMPORT = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

export function findImpureImports(source) {
  const hits = [];
  for (const match of source.matchAll(IMPORT)) {
    const spec = match[1];
    if (spec.startsWith(".") || spec.startsWith("node:")) continue;
    const root = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    if (FORBIDDEN.includes(root) || FORBIDDEN.includes(spec)) hits.push(spec);
  }
  return hits;
}
