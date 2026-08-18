import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { newId } from "@smos/domain";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const APP_URL = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const MIGRATION_URL = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";

const pool = createDbPool(APP_URL);
const db = createDb(pool);
const migrationPool = createDbPool(MIGRATION_URL);

const A = newId();
const B = newId();

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${A}::uuid, 'knowledge-tenant-A'), (${B}::uuid, 'knowledge-tenant-B')`,
  );
});

afterAll(async () => {
  // Runs even if an assertion above threw -- afterAll always executes in
  // vitest, so cleanup survives a failing test rather than leaking rows
  // only on the happy path. DATABASE_MIGRATION_URL (the smos role) is used
  // because smos_app has no DELETE grant, same as every other integration
  // test in this directory.
  await migrationPool.query("delete from knowledge_chunk where workspace_id = any($1::uuid[])", [[A, B]]);
  await migrationPool.query("delete from knowledge_document where workspace_id = any($1::uuid[])", [[A, B]]);
  await migrationPool.query("delete from workspace where id = any($1::uuid[])", [[A, B]]);
  await migrationPool.end();
  await pool.end();
});

describe("knowledge_document, knowledge_chunk -- row level security", () => {
  it("is enabled and forced on both tables", async () => {
    const r = await db.execute(
      sql`select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('knowledge_document', 'knowledge_chunk')`,
    );
    const rows = r.rows as { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it("rejects a tier outside the four allowed values", async () => {
    await expect(
      withTenant(pool, A, (tx) =>
        tx.query(`insert into knowledge_document (id, workspace_id, tier, title) values ($1, $2, 'not_a_real_tier', 'bad doc')`, [
          newId(),
          A,
        ]),
      ),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("a document and chunk belonging to workspace B are invisible when scoped to workspace A (cross-tenant read)", async () => {
    const docId = newId();
    const chunkId = newId();
    await withTenant(pool, B, async (tx) => {
      await tx.query(
        `insert into knowledge_document (id, workspace_id, tier, title) values ($1, $2, 't1_authoritative', 'B-only doc')`,
        [docId, B],
      );
      await tx.query(
        `insert into knowledge_chunk (id, workspace_id, document_id, ordinal, text) values ($1, $2, $3, 0, 'B-only chunk text')`,
        [chunkId, B, docId],
      );
    });

    const seenFromA = await withTenant(pool, A, (tx) =>
      tx.query("select count(*)::int as n from knowledge_chunk where id = $1", [chunkId]),
    );
    expect(seenFromA.rows[0].n).toBe(0);

    const seenFromB = await withTenant(pool, B, (tx) =>
      tx.query("select count(*)::int as n from knowledge_chunk where id = $1", [chunkId]),
    );
    expect(seenFromB.rows[0].n).toBe(1);
  });

  it("an insert tagged with workspace B is refused while scoped to workspace A (cross-tenant write)", async () => {
    await expect(
      withTenant(pool, A, (tx) =>
        // Session is scoped to A but this row claims workspace B -- the
        // policy's WITH CHECK must reject it outright.
        tx.query(
          `insert into knowledge_document (id, workspace_id, tier, title) values ($1, $2, 't1_authoritative', 'cross-tenant insert')`,
          [newId(), B],
        ),
      ),
    ).rejects.toThrow(/new row violates row-level security policy for table "knowledge_document"/);

    const ownDocId = newId();
    await withTenant(pool, A, (tx) =>
      tx.query(`insert into knowledge_document (id, workspace_id, tier, title) values ($1, $2, 't1_authoritative', 'A doc')`, [
        ownDocId,
        A,
      ]),
    );

    await expect(
      withTenant(pool, A, (tx) =>
        tx.query(
          `insert into knowledge_chunk (id, workspace_id, document_id, ordinal, text) values ($1, $2, $3, 0, 'cross-tenant chunk write')`,
          [newId(), B, ownDocId],
        ),
      ),
    ).rejects.toThrow(/new row violates row-level security policy for table "knowledge_chunk"/);
  });

  it("a chunk cannot be attached to another workspace's document even when correctly tagged with its own workspace_id (composite FK)", async () => {
    // B creates a document. A then tries to attach a chunk to it, tagging
    // the chunk with A's own workspace_id -- which satisfies RLS's WITH
    // CHECK on its own. Only the composite FK (document_id, workspace_id)
    // stands between this and a cross-tenant chunk silently inheriting B's
    // document's tier (the exact attack 0028_integration.sql's own header
    // describes for credential_reference -> integration).
    const bDocId = newId();
    await withTenant(pool, B, (tx) =>
      tx.query(`insert into knowledge_document (id, workspace_id, tier, title) values ($1, $2, 't1_authoritative', 'B doc, forged-FK probe')`, [
        bDocId,
        B,
      ]),
    );

    await expect(
      withTenant(pool, A, (tx) =>
        tx.query(`insert into knowledge_chunk (id, workspace_id, document_id, ordinal, text) values ($1, $2, $3, 0, 'forged FK attempt')`, [
          newId(),
          A,
          bDocId,
        ]),
      ),
    ).rejects.toThrow(/violates foreign key constraint/);
  });
});
