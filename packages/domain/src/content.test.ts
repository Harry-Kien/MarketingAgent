import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import { addVersion, createContentItem, canBeVerified } from "./content.ts";

const ws = newId();
const item = () =>
  createContentItem({ workspaceId: ws, campaignId: newId(), kind: "social_post", title: "Bài giới thiệu" });

describe("addVersion", () => {
  it("numbers versions from 1 upward", () => {
    const it0 = item();
    const v1 = addVersion(it0, { body: "nội dung", publicationContent: null, citations: [], qualityScore: null });
    const v2 = addVersion(
      { ...it0, latestVersionNumber: v1.versionNumber },
      { body: "nội dung 2", publicationContent: null, citations: [], qualityScore: null },
    );
    expect(v1.versionNumber).toBe(1);
    expect(v2.versionNumber).toBe(2);
  });

  it("rejects an empty body", () => {
    expect(() =>
      addVersion(item(), { body: "  ", publicationContent: null, citations: [], qualityScore: null }),
    ).toThrow(/body/i);
  });

  it("keeps publicationContent null until it is explicitly set", () => {
    const v = addVersion(item(), { body: "x", publicationContent: null, citations: [], qualityScore: null });
    expect(v.publicationContent).toBeNull();
  });
});

describe("canBeVerified", () => {
  it("is false without any citation", () => {
    expect(canBeVerified([])).toBe(false);
  });
  it("is false when a citation is not VERIFIED", () => {
    expect(
      canBeVerified([
        { id: newId(), url: "https://a.test", accessedAt: new Date(), excerpt: "e", verificationStatus: "UNVERIFIED" },
      ]),
    ).toBe(false);
  });
  it("is true only when every citation is VERIFIED", () => {
    expect(
      canBeVerified([
        { id: newId(), url: "https://a.test", accessedAt: new Date(), excerpt: "e", verificationStatus: "VERIFIED" },
      ]),
    ).toBe(true);
  });
});
