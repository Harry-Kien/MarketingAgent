/**
 * Relative imports must carry a .ts extension, not .js.
 *
 * Writing .js is the older TypeScript convention and it type-checks fine, but
 * it only resolves under tsc and vitest. Turbopack fails with "Module not
 * found", and Node's --experimental-strip-types fails with ERR_MODULE_NOT_FOUND.
 * tsconfig sets rewriteRelativeImportExtensions so the emitted JavaScript still
 * gets .js, which is what Node ESM needs at runtime.
 */
const RELATIVE_JS_IMPORT = /(?:from|import)\s*\(?\s*["'](\.[^"']*\.js)["']/g;

export function findJsRelativeImports(source) {
  const hits = [];
  for (const match of source.matchAll(RELATIVE_JS_IMPORT)) hits.push(match[1]);
  return hits;
}
