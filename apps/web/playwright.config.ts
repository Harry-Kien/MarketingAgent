import { defineConfig, devices } from "@playwright/test";

/**
 * Real-browser E2E (E7): golden-sequence.test.ts (same e2e/ directory) is a
 * vitest test that deliberately does NOT use a browser -- see its own
 * header for why. This config is for the separate, genuinely
 * browser-driven suite this task adds now that requireWorkspace() resolves
 * a real session: `*.spec.ts` files only (never `*.test.ts`, which vitest's
 * own `include` glob already owns -- keeping the extensions disjoint means
 * neither runner ever tries to execute the other's files).
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env["E2E_BASE_URL"] ?? "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  webServer: {
    // Root .env (DATABASE_URL, BETTER_AUTH_SECRET, ...) is loaded by
    // next.config.ts itself, not by this config -- see that file's header.
    command: "npm run dev --workspace @smos/web",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: process.env["CI"] !== "true",
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
