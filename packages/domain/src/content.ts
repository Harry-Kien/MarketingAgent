import { DomainError } from "./errors.ts";
import { newId, type Id } from "./ids.ts";

class ContentValidationError extends DomainError {
  readonly code = "CONTENT_INVALID";
}

// Single source of truth for the allowed values: infra/migrations'
// CHECK constraints and the db-level tests are written by reading these
// arrays, not by retyping the literals from memory, so the two can never
// silently drift apart.
export const CONTENT_KINDS = ["social_post", "email", "landing_page", "long_form", "faq"] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export const VERIFICATION_STATUSES = ["VERIFIED", "INFERRED", "HYPOTHESIS", "UNVERIFIED"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export interface SourceCitation {
  id: Id;
  url: string;
  accessedAt: Date;
  excerpt: string;
  verificationStatus: VerificationStatus;
}

export interface ContentItem {
  id: Id;
  workspaceId: Id;
  campaignId: Id;
  kind: ContentKind;
  title: string;
  latestVersionNumber: number;
}

export interface ContentVersion {
  id: Id;
  workspaceId: Id;
  contentItemId: Id;
  versionNumber: number;
  body: string;
  /** Verbatim text that will be published. Null until an agent sets it. */
  publicationContent: string | null;
  citations: SourceCitation[];
  /** Display and QA signal only. NEVER used to grant execution permission. */
  qualityScore: number | null;
  createdAt: Date;
}

export function createContentItem(input: {
  workspaceId: Id;
  campaignId: Id;
  kind: ContentKind;
  title: string;
}): ContentItem {
  if (input.title.trim().length === 0) {
    throw new ContentValidationError("Content title cannot be blank");
  }
  return {
    id: newId(),
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    kind: input.kind,
    title: input.title.trim(),
    latestVersionNumber: 0,
  };
}

export function addVersion(
  item: ContentItem,
  input: { body: string; publicationContent: string | null; citations: SourceCitation[]; qualityScore: number | null },
): ContentVersion {
  if (input.body.trim().length === 0) {
    throw new ContentValidationError("Content body cannot be blank");
  }
  return {
    id: newId(),
    workspaceId: item.workspaceId,
    contentItemId: item.id,
    versionNumber: item.latestVersionNumber + 1,
    body: input.body,
    publicationContent: input.publicationContent,
    citations: input.citations,
    qualityScore: input.qualityScore,
    createdAt: new Date(),
  };
}

/** A claim is only VERIFIED when every citation backing it is VERIFIED. */
export function canBeVerified(citations: SourceCitation[]): boolean {
  return citations.length > 0 && citations.every((c) => c.verificationStatus === "VERIFIED");
}
