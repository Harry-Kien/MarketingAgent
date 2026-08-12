import { defineConfig } from "vitest/config";

export default defineConfig({
  // apps/web's tsconfig sets "jsx": "preserve" for Next.js's own bundler to
  // consume. Vitest transforms .tsx itself (via esbuild) and does not go
  // through Next -- "preserve" is not a valid esbuild jsx mode, so without
  // this override every .tsx test file fails at the import-analysis step
  // before a single test runs. This does not affect `tsc --noEmit`, which
  // reads tsconfig directly and is unaffected by esbuild options here.
  oxc: {
    jsx: { runtime: "automatic" },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // dist/ holds compiled copies of the same tests. Without this exclude every
    // test runs twice, which doubles CI time and makes failures ambiguous.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    include: ["**/*.test.{ts,tsx,mts,mjs}"],
    // Integration tests talk to one shared PostgreSQL, so they must not race.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
