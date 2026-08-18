import type pg from "pg";
import type { Id } from "@smos/domain";
import { withTenant } from "@smos/db";

export type KnowledgeTier = "t1_authoritative" | "t2_reference" | "t3_hint" | "t4_voice";

export interface RetrievedChunk {
  chunkId: Id;
  documentId: Id;
  tier: KnowledgeTier;
  text: string;
  distance: number;
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * The tier filter is a security control, not a convenience (D3,
 * docs/superpowers/specs/2026-08-18-customer-advisory-agent-design.md
 * section 2): it is a WHERE clause evaluated by PostgreSQL against
 * knowledge_document.tier, before ORDER BY ever ranks anything. A T3
 * chunk closer in vector space than every T1 chunk still cannot be
 * returned to a T1-only query -- the query never sees it in the first
 * place, the same way RLS never lets the wrong workspace's rows into a
 * result set to begin with.
 *
 * Runs inside withTenant (packages/db/src/tenant-scope.ts) so the tenant
 * boundary is enforced by PostgreSQL's RLS itself, not by this function's
 * own SQL -- exactly the discipline every other read in this codebase
 * follows.
 */
export async function retrieve(
  pool: pg.Pool,
  workspaceId: Id,
  input: { queryEmbedding: number[]; tiers: KnowledgeTier[]; limit: number },
): Promise<RetrievedChunk[]> {
  if (input.tiers.length === 0) {
    throw new Error("retrieve requires at least one tier in input.tiers");
  }
  if (!Number.isFinite(input.limit) || input.limit <= 0) {
    throw new Error(`retrieve requires a finite limit > 0, got ${input.limit}`);
  }

  const vectorLiteral = toVectorLiteral(input.queryEmbedding);

  const result = await withTenant(pool, workspaceId, (tx) =>
    tx.query(
      `SELECT c.id AS chunk_id, c.document_id, d.tier, c.text, (c.embedding <=> $1::vector) AS distance
       FROM knowledge_chunk c
       JOIN knowledge_document d ON d.id = c.document_id AND d.workspace_id = c.workspace_id
       WHERE d.tier = ANY($2::text[])
       ORDER BY c.embedding <=> $1::vector
       LIMIT $3`,
      [vectorLiteral, input.tiers, input.limit],
    ),
  );

  return result.rows.map((row) => ({
    chunkId: row.chunk_id as Id,
    documentId: row.document_id as Id,
    tier: row.tier as KnowledgeTier,
    text: row.text as string,
    distance: Number(row.distance),
  }));
}
