import { defineConfig } from "vitest/config";

export default defineConfig({
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
