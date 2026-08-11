// Applies every .sql file in infra/migrations/, in filename order, exactly
// once each. Forward-only: there is no down-migration concept here.
//
// Tracking is done in a `schema_migration` table that this script creates
// itself (never via a file under infra/migrations/), so check-migrations.mjs
// never sees a CREATE TABLE for it -- it is not declared by any migration
// file, so the guard has no text to scan in the first place. It is still
// listed in GLOBAL_TABLES (scripts/migration-guards.mjs) so that allowlist
// tells the truth about every table that actually exists; task 12's
// cross-tenant.test.ts is what actually cross-checks it (task-12-report.md).
//
// Each migration file is applied inside its own transaction: either every
// statement in the file commits, or none of them do. A failure stops the run
// immediately (no later files are attempted) and exits non-zero, naming the
// file that failed.
//
// ADR-007: this script is the ONLY thing that connects with
// DATABASE_MIGRATION_URL (the `smos` superuser, needed to run DDL and to
// ALTER the smos_app role itself). Everything else -- the app, the worker,
// every test -- connects with DATABASE_URL (`smos_app`, no BYPASSRLS).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

// Same loading convention as vitest.setup.ts: local runs pick up .env
// automatically, CI sets the variables directly and has no .env file.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const MIGRATIONS_DIR = "infra/migrations";

const url =
  process.env["DATABASE_MIGRATION_URL"] ??
  "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";

async function main() {
  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        filename    text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const { rows: appliedRows } = await client.query("SELECT filename FROM schema_migration");
    const applied = new Set(appliedRows.map((r) => r.filename));

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skipped: ${file} (already applied)`);
        continue;
      }

      const sqlText = readFileSync(join(MIGRATIONS_DIR, file), "utf8");

      try {
        await client.query("BEGIN");
        await client.query(sqlText);
        await client.query("INSERT INTO schema_migration (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`applied: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        console.error(`migration failed: ${file}`);
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 1;
        return;
      }
    }

    // Migrations give smos_app LOGIN (0002) but never its password -- that
    // would put a credential in a file npm run lint:secrets scans, and
    // infra/migrations/ is forward-only, checked-in, and reviewable, which
    // is exactly the wrong place for one. Set it here instead, from an
    // environment variable that must be provided explicitly: no hardcoded
    // fallback, ever.
    const smosAppPassword = process.env["SMOS_APP_PASSWORD"];
    if (!smosAppPassword) {
      console.error(
        "SMOS_APP_PASSWORD is not set. Refusing to leave smos_app without a " +
          "password: set SMOS_APP_PASSWORD (see .env.example) and re-run " +
          "npm run db:migrate.",
      );
      process.exitCode = 1;
      return;
    }
    // PostgreSQL's ALTER ROLE ... PASSWORD clause takes a string literal in
    // its grammar, not a general expression, so a $1 bind parameter is not
    // accepted there. client.escapeLiteral produces a safely quoted literal
    // (doubles embedded quotes, escapes backslashes) so the password is
    // still never interpolated unescaped.
    await client.query(`ALTER ROLE smos_app PASSWORD ${client.escapeLiteral(smosAppPassword)}`);
    console.log("smos_app password set from SMOS_APP_PASSWORD");

    // Same pattern, for the worker's own login role (0017_outbox_claim_token.sql):
    // smos_worker is a separate credential from smos_app so the worker process
    // (the only thing with EXECUTE on outbox_claim_batch / outbox_mark_published)
    // is not reachable using the web app's own DATABASE_URL.
    const smosWorkerPassword = process.env["SMOS_WORKER_PASSWORD"];
    if (!smosWorkerPassword) {
      console.error(
        "SMOS_WORKER_PASSWORD is not set. Refusing to leave smos_worker without a " +
          "password: set SMOS_WORKER_PASSWORD (see .env.example) and re-run " +
          "npm run db:migrate.",
      );
      process.exitCode = 1;
      return;
    }
    await client.query(
      `ALTER ROLE smos_worker PASSWORD ${client.escapeLiteral(smosWorkerPassword)}`,
    );
    console.log("smos_worker password set from SMOS_WORKER_PASSWORD");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("migration runner failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
