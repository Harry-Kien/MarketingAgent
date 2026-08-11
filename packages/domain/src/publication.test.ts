import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import { buildPublication, hashPublicationContent } from "./publication.ts";
import { PublicationIntegrityError } from "./errors.ts";
import type { ContentVersion } from "./content.ts";

const version = (publicationContent: string | null): ContentVersion => ({
  id: newId(),
  workspaceId: newId(),
  contentItemId: newId(),
  versionNumber: 1,
  body: "thân bài",
  publicationContent,
  citations: [],
  qualityScore: 90,
  createdAt: new Date(),
});

const input = (v: ContentVersion) => ({
  workspaceId: v.workspaceId,
  campaignId: newId(),
  contentVersion: v,
  approvalDecisionId: newId(),
  targetChannel: "meta_page",
});

describe("buildPublication", () => {
  it("refuses a version without publicationContent", () => {
    expect(() => buildPublication(input(version(null)))).toThrow(PublicationIntegrityError);
  });

  it("refuses blank publicationContent", () => {
    expect(() => buildPublication(input(version("   ")))).toThrow(/publication content/i);
  });

  it("refuses an empty-string publicationContent", () => {
    expect(() => buildPublication(input(version("")))).toThrow(PublicationIntegrityError);
  });

  it("refuses publicationContent made only of tabs and newlines", () => {
    expect(() => buildPublication(input(version("\t\n")))).toThrow(PublicationIntegrityError);
  });

  it("carries the exact text that will be published", () => {
    const p = buildPublication(input(version("Bài đăng thật")));
    expect(p.publicationContent).toBe("Bài đăng thật");
    expect(p.state).toBe("prepared");
  });

  it("hashes the content so execute time can detect drift", () => {
    const p = buildPublication(input(version("Bài đăng thật")));
    expect(p.contentHash).toBe(hashPublicationContent("Bài đăng thật"));
  });

  it("derives a stable idempotency key from decision and content", () => {
    const v = version("Bài đăng thật");
    const i = input(v);
    expect(buildPublication(i).idempotencyKey).toBe(buildPublication(i).idempotencyKey);
  });

  it("changes the idempotency key when the content changes", () => {
    const i1 = input(version("A"));
    const i2 = { ...i1, contentVersion: version("B") };
    expect(buildPublication(i1).idempotencyKey).not.toBe(buildPublication(i2).idempotencyKey);
  });
});
