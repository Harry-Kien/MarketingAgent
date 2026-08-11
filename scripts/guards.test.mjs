import { describe, expect, it } from "vitest";
import { findForbiddenDeps, findForbiddenScope, findRangeVersions } from "./guards.mjs";

describe("findRangeVersions", () => {
  it("flags caret and tilde ranges", () => {
    const found = findRangeVersions({
      dependencies: { next: "^16.3.0", zod: "~4.4.3", pg: "8.16.3" },
    });
    expect(found).toEqual(["next@^16.3.0", "zod@~4.4.3"]);
  });

  it("allows workspace wildcards", () => {
    expect(findRangeVersions({ dependencies: { "@smos/db": "*" } })).toEqual([]);
  });
});

describe("findForbiddenDeps", () => {
  it("flags dependencies banned by the plan index", () => {
    const found = findForbiddenDeps({ dependencies: { prisma: "7.9.1", ioredis: "5.0.0" } });
    expect(found).toContain("prisma");
    expect(found).toContain("ioredis");
  });

  it("allows the approved stack", () => {
    expect(findForbiddenDeps({ dependencies: { "drizzle-orm": "0.45.2", "pg-boss": "12.27.0" } })).toEqual([]);
  });
});

describe("findForbiddenScope", () => {
  it("flags out-of-scope route names", () => {
    expect(findForbiddenScope(["apps/web/src/app/billing/page.tsx"])).toContain(
      "apps/web/src/app/billing/page.tsx",
    );
  });

  it("allows docs that merely mention the words", () => {
    expect(findForbiddenScope(["docs/adr/ADR-007-tenant-isolation-and-rls.md"])).toEqual([]);
  });

  it("allows ordinary source paths", () => {
    expect(findForbiddenScope(["packages/domain/src/campaign.ts"])).toEqual([]);
  });
});
