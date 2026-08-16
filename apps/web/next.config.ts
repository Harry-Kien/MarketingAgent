import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

// Next loads .env from the app directory, but this monorepo keeps a single
// .env at the repo root so the web app, the worker and vitest all read the
// same values. next.config.ts runs before the server boots, which is early
// enough for route handlers to see them.
const rootEnv = resolve(import.meta.dirname, "../../.env");
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source rather than build output, so
  // Next has to compile them itself.
  transpilePackages: ["@smos/contracts", "@smos/db", "@smos/domain", "@smos/telemetry", "@smos/worker"],
  // Playwright's own default baseURL is http://127.0.0.1:3000
  // (apps/web/playwright.config.ts) -- Next 16 dev mode otherwise blocks
  // cross-origin requests for HMR/static chunks from any host other than
  // "localhost" as a dev-only safety default, which broke the E7 browser
  // suite outright (chunks never loaded, so nothing beyond the initial HTML
  // ever rendered). Dev-mode-only setting; irrelevant to `next build`/
  // `next start`.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default config;
