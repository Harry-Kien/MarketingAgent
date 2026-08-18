import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { newId } from "@smos/domain";
import { createDb, createDbPool, withTenant } from "@smos/db";
import { createFakeEmbedder } from "./embed.ts";
import { retrieve } from "./retrieve.ts";

const APP_URL = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const MIGRATION_URL = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";

const pool = createDbPool(APP_URL);
const db = createDb(pool);
const migrationPool = createDbPool(MIGRATION_URL);
const embedder = createFakeEmbedder(1024);

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

const WORKSPACE = newId();

beforeAll(async () => {
  await db.execute(sql`insert into workspace (id, name) values (${WORKSPACE}::uuid, 'retrieve-tier-filter')`);
});

afterAll(async () => {
  await migrationPool.query("delete from knowledge_chunk where workspace_id = $1", [WORKSPACE]);
  await migrationPool.query("delete from knowledge_document where workspace_id = $1", [WORKSPACE]);
  await migrationPool.query("delete from workspace where id = $1", [WORKSPACE]);
  await migrationPool.end();
  await pool.end();
});

describe("retrieve -- tier-filtered vector search", () => {
  it("never returns a t3_hint chunk to a query restricted to t1_authoritative, even when the t3 chunk is the closer vector match", async () => {
    const [queryVector, t1Vector] = await embedder.embed(["gia bao nhieu", "chinh sach bao hanh 12 thang"]);

    const t1DocId = newId();
    const t1ChunkId = newId();
    const t3DocId = newId();
    const t3ChunkId = newId();

    await withTenant(pool, WORKSPACE, async (tx) => {
      await tx.query(
        `insert into knowledge_document (id, workspace_id, tier, title) values ($1, $2, 't1_authoritative', 'Bang gia chinh thuc')`,
        [t1DocId, WORKSPACE],
      );
      await tx.query(
        `insert into knowledge_chunk (id, workspace_id, document_id, ordinal, text, embedding) values ($1, $2, $3, 0, 'chinh sach bao hanh 12 thang', $4::vector)`,
        [t1ChunkId, WORKSPACE, t1DocId, toVectorLiteral(t1Vector!)],
      );

      await tx.query(
        `insert into knowledge_document (id, workspace_id, tier, title) values ($1, $2, 't3_hint', 'Website cu, chua cap nhat')`,
        [t3DocId, WORKSPACE],
      );
      // The t3 chunk's embedding is set to the query vector itself, so its
      // distance is exactly 0 -- the closest possible match, strictly
      // closer than the t1 chunk above. If the tier filter were a
      // convenience rather than an enforced WHERE clause, this chunk
      // would win.
      await tx.query(
        `insert into knowledge_chunk (id, workspace_id, document_id, ordinal, text, embedding) values ($1, $2, $3, 0, 'gia bao nhieu, hoi nam ngoai', $4::vector)`,
        [t3ChunkId, WORKSPACE, t3DocId, toVectorLiteral(queryVector!)],
      );
    });

    const results = await retrieve(pool, WORKSPACE, {
      queryEmbedding: queryVector!,
      tiers: ["t1_authoritative"],
      limit: 5,
    });

    expect(results.map((r) => r.chunkId)).not.toContain(t3ChunkId);
    expect(results.map((r) => r.chunkId)).toContain(t1ChunkId);
    for (const r of results) {
      expect(r.tier).toBe("t1_authoritative");
    }
  });

  it("orders results by ascending cosine distance within the allowed tiers", async () => {
    const [queryVector] = await embedder.embed(["bao hanh"]);
    // A tiny, deterministic perturbation (one dimension flipped) stays
    // nearly identical in direction -- guaranteed small cosine distance --
    // without depending on the fake embedder's hashes being semantically
    // "close" for related Vietnamese phrases, which they are not.
    const nearVector = queryVector!.map((v, i) => (i === 0 ? -v : v));
    const [farVector] = await embedder.embed(["mot chu de hoan toan khac, khong lien quan"]);

    const docId = newId();
    const nearChunkId = newId();
    const farChunkId = newId();

    await withTenant(pool, WORKSPACE, async (tx) => {
      await tx.query(`insert into knowledge_document (id, workspace_id, tier, title) values ($1, $2, 't1_authoritative', 'FAQ bao hanh')`, [
        docId,
        WORKSPACE,
      ]);
      await tx.query(
        `insert into knowledge_chunk (id, workspace_id, document_id, ordinal, text, embedding) values ($1, $2, $3, 0, 'far chunk', $4::vector)`,
        [farChunkId, WORKSPACE, docId, toVectorLiteral(farVector!)],
      );
      await tx.query(
        `insert into knowledge_chunk (id, workspace_id, document_id, ordinal, text, embedding) values ($1, $2, $3, 1, 'near chunk', $4::vector)`,
        [nearChunkId, WORKSPACE, docId, toVectorLiteral(nearVector)],
      );
    });

    const results = await retrieve(pool, WORKSPACE, { queryEmbedding: queryVector!, tiers: ["t1_authoritative"], limit: 5 });

    const nearIndex = results.findIndex((r) => r.chunkId === nearChunkId);
    const farIndex = results.findIndex((r) => r.chunkId === farChunkId);
    expect(nearIndex).toBeGreaterThanOrEqual(0);
    expect(farIndex).toBeGreaterThanOrEqual(0);
    expect(results[nearIndex]!.distance).toBeLessThan(results[farIndex]!.distance);
    expect(nearIndex).toBeLessThan(farIndex);
  });
});
