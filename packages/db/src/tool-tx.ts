import type pg from "pg";
import { type Id, type VerificationStatus } from "@smos/domain";
import { withTenant, type TenantTx } from "./tenant-scope.ts";

/**
 * The narrow handle P2's agent tools receive instead of TenantTx.
 *
 * ADR-007's three-layer defence assumes layer 1 (application code) can be
 * wrong. P2 runs LLM-driven tool implementations on content the blueprint
 * explicitly treats as untrusted -- a tool body is exactly the kind of
 * layer-1 code that can be wrong, on purpose or by injected instruction.
 * TenantTx.query(text, values) accepts arbitrary SQL text, which means
 * handing a TenantTx to tool code would let a compromised or buggy tool
 * call set_config('app.workspace_id', ...) or SET ROLE to re-scope itself
 * mid-call -- the exact hijack withTenant's boundary check (tenant-scope.ts)
 * now detects and refuses to let persist. Detecting it at COMMIT time is a
 * backstop, not a substitute for not handing out the capability at all.
 *
 * ToolTx is that: no `query`, no `execute`, nothing that takes a raw SQL
 * string. Every operation is named, typed, and does exactly one thing a P2
 * tool is known to need -- reading a campaign, reading a content item's
 * version history and citations, and appending a new content version.
 * Repositories and other infrastructure keep using the full TenantTx via
 * `withTenant`; only tool bodies get this.
 *
 * Handing a TenantTx to tool code is the thing this interface exists to
 * prevent. If a future change needs to widen what a tool can do, add a new
 * named method here -- never add a `query` escape hatch back onto ToolTx.
 */
export interface ToolCampaign {
  readonly id: Id;
  readonly goalId: Id;
  readonly name: string;
  readonly state: string;
  readonly version: number;
}

export interface ToolContentItem {
  readonly id: Id;
  readonly campaignId: Id;
  readonly kind: string;
  readonly title: string;
}

export interface ToolContentVersion {
  readonly id: Id;
  readonly contentItemId: Id;
  readonly versionNumber: number;
  readonly body: string;
  readonly publicationContent: string | null;
  readonly qualityScore: number | null;
  readonly createdAt: Date;
}

export interface ToolSourceCitation {
  readonly id: Id;
  readonly contentVersionId: Id;
  readonly url: string;
  readonly accessedAt: Date;
  readonly excerpt: string;
  readonly verificationStatus: VerificationStatus;
}

export interface ToolTx {
  /** Read one campaign. Null if it does not exist in this scope's workspace. */
  readCampaign(campaignId: Id): Promise<ToolCampaign | null>;

  /** Read one content item's metadata. Null if it does not exist in this scope's workspace. */
  readContentItem(contentItemId: Id): Promise<ToolContentItem | null>;

  /** Every version of a content item, oldest first, for a research/content/QA tool to review prior drafts. */
  listContentVersions(contentItemId: Id): Promise<ToolContentVersion[]>;

  /** The citations backing a specific content version -- the "research rows" a QA or content tool checks claims against. */
  listSourceCitations(contentVersionId: Id): Promise<ToolSourceCitation[]>;

  /**
   * Append the next version of a content item and its citations, atomically.
   * version_number is computed server-side (max existing + 1 for this
   * content item), so a tool can never choose, collide with, or overwrite
   * a version number itself.
   */
  writeContentVersion(input: {
    contentItemId: Id;
    body: string;
    publicationContent: string | null;
    qualityScore: number | null;
    citations: ReadonlyArray<{
      url: string;
      accessedAt: Date;
      excerpt: string;
      verificationStatus: VerificationStatus;
    }>;
  }): Promise<Id>;
}

/**
 * The entry point tool wiring code should use: it never yields a TenantTx,
 * only the narrow ToolTx above, so there is no accidental path from "P2
 * needs to wire up a tool" to "a tool body holds an object with .query()".
 */
export async function withTenantTools<T>(
  pool: pg.Pool,
  workspaceId: Id,
  fn: (tools: ToolTx) => Promise<T>,
): Promise<T> {
  return withTenant(pool, workspaceId, (tx) => fn(createToolTx(tx)));
}

function createToolTx(tx: TenantTx): ToolTx {
  return {
    async readCampaign(campaignId) {
      const r = await tx.query(
        `select id, goal_id, name, state, version from campaign where id = $1`,
        [campaignId],
      );
      const row = r.rows[0] as
        | { id: Id; goal_id: Id; name: string; state: string; version: number }
        | undefined;
      if (row === undefined) return null;
      return { id: row.id, goalId: row.goal_id, name: row.name, state: row.state, version: row.version };
    },

    async readContentItem(contentItemId) {
      const r = await tx.query(
        `select id, campaign_id, kind, title from content_item where id = $1`,
        [contentItemId],
      );
      const row = r.rows[0] as { id: Id; campaign_id: Id; kind: string; title: string } | undefined;
      if (row === undefined) return null;
      return { id: row.id, campaignId: row.campaign_id, kind: row.kind, title: row.title };
    },

    async listContentVersions(contentItemId) {
      const r = await tx.query(
        `select id, content_item_id, version_number, body, publication_content, quality_score, created_at
         from content_version where content_item_id = $1 order by version_number asc`,
        [contentItemId],
      );
      return (
        r.rows as Array<{
          id: Id;
          content_item_id: Id;
          version_number: number;
          body: string;
          publication_content: string | null;
          quality_score: number | null;
          created_at: Date;
        }>
      ).map((row) => ({
        id: row.id,
        contentItemId: row.content_item_id,
        versionNumber: row.version_number,
        body: row.body,
        publicationContent: row.publication_content,
        qualityScore: row.quality_score,
        createdAt: row.created_at,
      }));
    },

    async listSourceCitations(contentVersionId) {
      const r = await tx.query(
        `select id, content_version_id, url, accessed_at, excerpt, verification_status
         from source_citation where content_version_id = $1 order by created_at asc`,
        [contentVersionId],
      );
      return (
        r.rows as Array<{
          id: Id;
          content_version_id: Id;
          url: string;
          accessed_at: Date;
          excerpt: string;
          verification_status: VerificationStatus;
        }>
      ).map((row) => ({
        id: row.id,
        contentVersionId: row.content_version_id,
        url: row.url,
        accessedAt: row.accessed_at,
        excerpt: row.excerpt,
        verificationStatus: row.verification_status,
      }));
    },

    async writeContentVersion(input) {
      const next = await tx.query(
        `select coalesce(max(version_number), 0) + 1 as n from content_version where content_item_id = $1`,
        [input.contentItemId],
      );
      const versionNumber = (next.rows[0] as { n: number }).n;

      const inserted = await tx.query(
        `insert into content_version
           (id, workspace_id, content_item_id, version_number, body, publication_content, quality_score)
         values (gen_random_uuid(), current_setting('app.workspace_id', true)::uuid, $1, $2, $3, $4, $5)
         returning id`,
        [input.contentItemId, versionNumber, input.body, input.publicationContent, input.qualityScore],
      );
      const contentVersionId = (inserted.rows[0] as { id: Id }).id;

      for (const citation of input.citations) {
        await tx.query(
          `insert into source_citation
             (id, workspace_id, content_version_id, url, accessed_at, excerpt, verification_status)
           values (gen_random_uuid(), current_setting('app.workspace_id', true)::uuid, $1, $2, $3, $4, $5)`,
          [contentVersionId, citation.url, citation.accessedAt, citation.excerpt, citation.verificationStatus],
        );
      }

      return contentVersionId;
    },
  };
}
