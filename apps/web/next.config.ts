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
  transpilePackages: ["@smos/contracts", "@smos/db", "@smos/telemetry"],
};

export default config;
