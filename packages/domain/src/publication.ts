import { createHash } from "node:crypto";
import type { ContentVersion } from "./content.ts";
import { PublicationIntegrityError } from "./errors.ts";
import { newId, type Id } from "./ids.ts";

export interface Publication {
  id: Id;
  workspaceId: Id;
  campaignId: Id;
  contentVersionId: Id;
  approvalDecisionId: Id;
  publicationContent: string;
  contentHash: string;
  idempotencyKey: string;
  targetChannel: string;
  state: "prepared";
  createdAt: Date;
}

export function hashPublicationContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The Publication Artifact Contract (E3): a publication cannot exist without
 * the verbatim text that will actually be posted, and cannot exist without a
 * recorded human approval decision. This is what stops a connector from
 * publishing an internal brief to a real page. `.trim()` mirrors the
 * Unicode-aware blank check used everywhere else in this package
 * (approval.ts, campaign.ts, content.ts) -- it rejects tabs/newlines-only
 * text, not just plain-space-only text, matching the database's `~ '\S'`
 * CHECK (infra/migrations/0010_publication.sql) rather than a narrower
 * ASCII-space-only version of it.
 */
export function buildPublication(input: {
  workspaceId: Id;
  campaignId: Id;
  contentVersion: ContentVersion;
  approvalDecisionId: Id;
  targetChannel: string;
}): Publication {
  const text = input.contentVersion.publicationContent;
  if (text === null || text.trim().length === 0) {
    throw new PublicationIntegrityError("A publication requires non-empty publication content");
  }
  const contentHash = hashPublicationContent(text);
  return {
    id: newId(),
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    contentVersionId: input.contentVersion.id,
    approvalDecisionId: input.approvalDecisionId,
    publicationContent: text,
    contentHash,
    idempotencyKey: createHash("sha256")
      .update(`${input.approvalDecisionId}:${contentHash}`)
      .digest("hex"),
    targetChannel: input.targetChannel,
    state: "prepared",
    createdAt: new Date(),
  };
}
