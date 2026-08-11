// Applies every .sql file in infra/migrations/, in filename order, exactly
// once each. Forward-only: there is no down-migration concept here.
//
// Tracking is done in a `schema_migration` table that this script creates
// itself (never via a file under infra/migrations/), so it is infrastructure
// the migration guard never has to know about — it is not declared by any
// migration file, so scripts/check-migrations.mjs never sees a CREATE TABLE
// for it and there is nothing to add to GLOBAL_TABLES.
//
// Each migration file is applied inside its own transaction: either every
// statement in the file commits, or none of them do. A failure stops the run
// immediately (no later files are attempted) and exits non-zero, naming the
// file that failed.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = "infra/migrations";

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";

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
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("migration runner failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
