import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // dist/ holds compiled copies of the same tests. Without this exclude every
    // test runs twice, which doubles CI time and makes failures ambiguous.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    include: ["**/*.test.{ts,tsx,mts,mjs}"],
  },
});
