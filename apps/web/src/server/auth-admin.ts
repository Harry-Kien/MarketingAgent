import { createDbPool } from "@smos/db";
import { createSmosAuth } from "./auth.ts";

/**
 * TEST/SEED ONLY. Never imported by any route or by `apps/web/src/server/
 * auth.ts`'s own `auth` export -- grep this repo for the only two legitimate
 * importers (`apps/web/src/server/auth.test.ts`,
 * `apps/web/e2e/fixtures/auth-seed.ts`) before adding a third.
 *
 * Connects with DATABASE_MIGRATION_URL (the `smos` superuser) instead of
 * the shared smos_app pool, and enables sign-up (`disableSignUp: false`),
 * so it can provision a real user + hashed-password credential the same
 * way `scripts/apply-migrations.mjs` and every existing test fixture
 * (`packages/testing/src/tenant-fixtures.ts`,
 * `packages/db/src/approval-invariants.test.ts`'s own `seedUser`) already
 * provision `user_account` rows: as an administrative act through the
 * migration role, never through smos_app. smos_app has no INSERT on
 * user_account at all (0030_user_account_no_app_write.sql) -- the running
 * app's own `auth` instance could not do this even if `disableSignUp` were
 * flipped.
 */
const adminUrl =
  process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";

export const adminAuth = createSmosAuth(createDbPool(adminUrl), { disableSignUp: false });
