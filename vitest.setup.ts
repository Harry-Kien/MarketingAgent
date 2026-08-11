import { existsSync } from "node:fs";

// Node 20.12+ ships loadEnvFile, so local runs pick up DATABASE_URL without a
// dotenv dependency. CI sets the variables directly and has no .env file.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}
