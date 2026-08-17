// P2's agent tools run inside withTenant's callback on content the blueprint
// treats as untrusted (ADR-007's layer 1 running arbitrary logic). This
// suite proves ToolTx -- the handle tool code actually receives -- covers
// what P2's tools need (reading campaigns, reading a content item's version
// history and citations, appending a new content version) without ever
// exposing a way to run arbitrary SQL text, and that tenant isolation still
// holds through it exactly as it does through the full TenantTx.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";
import { withTenantTools, type ToolTx } from "./tool-tx.ts";

const url =
  process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);
const A = "33333333-3333-7333-8333-333333333333";
const B = "44444444-4444-7444-8444-444444444444";

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${A}::uuid, 'tool-tx-A'), (${B}::uuid, 'tool-tx-B') on conflict do nothing`,
  );
});

afterAll(async () => {
  await pool.end();
});

async function seedCampaignAndItem(workspaceId: string) {
  return withTenant(pool, workspaceId, async (tx) => {
    const goal = await tx.query(
      `insert into goal (id, workspace_id, statement) values (gen_random_uuid(), $1, 'tool-tx probe') returning id`,
      [workspaceId],
    );
    const campaign = await tx.query(
      `insert into campaign (id, workspace_id, goal_id, name, state)
       values (gen_random_uuid(), $1, $2, $3, 'DRAFT') returning id`,
      [workspaceId, goal.rows[0].id, `tool-tx campaign ${Date.now()}-${Math.random()}`],
    );
    const item = await tx.query(
      `insert into content_item (id, workspace_id, campaign_id, kind, title)
       values (gen_random_uuid(), $1, $2, 'social_post', $3) returning id`,
      [workspaceId, campaign.rows[0].id, `tool-tx item ${Date.now()}-${Math.random()}`],
    );
    return { campaignId: campaign.rows[0].id as string, contentItemId: item.rows[0].id as string };
  });
}

describe("ToolTx surface", () => {
  it("exposes exactly the narrow, named operations P2's tools need -- nothing that runs arbitrary SQL text", async () => {
    await withTenantTools(pool, A, async (tools) => {
      const names = Object.keys(tools).sort();
      expect(names).toEqual([
        "listContentVersions",
        "listSourceCitations",
        "readCampaign",
        "readContentItem",
        "writeContentVersion",
      ]);
      for (const name of names) {
        expect(typeof (tools as unknown as Record<string, unknown>)[name]).toBe("function");
      }
      // The specific capability this interface exists to withhold.
      expect((tools as unknown as Record<string, unknown>)["query"]).toBeUndefined();
      expect((tools as unknown as Record<string, unknown>)["execute"]).toBeUndefined();
      expect((tools as unknown as Record<string, unknown>)["raw"]).toBeUndefined();
      expect((tools as unknown as Record<string, unknown>)["sql"]).toBeUndefined();
    });
  });

  // NOT A TEST -- type-level documentation only, verified by nothing in the
  // verify chain. `it.skip` (not `it`) so the runner reports it as skipped
  // rather than a misleadingly green pass.
  //
  // The `@ts-expect-error` below is inert under both commands that could
  // conceivably check it:
  //   - `npm test` (vitest): transforms this file with esbuild, which
  //     strips types without type-checking them. `@ts-expect-error` is
  //     never evaluated; `tools.query` is just a harmless property access
  //     on `undefined` at runtime, so this "test" could never go red even
  //     before that.
  //   - `npm run typecheck` (`tsc --build`): packages/db/tsconfig.json has
  //     `"exclude": ["src/**/*.test.ts"]` (true of every package in this
  //     repo except apps/web), so this file is never a compilation root.
  // Confirmed empirically: pointing a scratch tsconfig at this file alone
  // (include: ["src/tool-tx.test.ts"], no test exclusion) does make
  // `@ts-expect-error` real -- but it also surfaces ~28 pre-existing,
  // unrelated type errors elsewhere in this file (untyped `Id` literals,
  // `unknown`-typed query results, etc.) that predate this task and are
  // out of scope to fix here. Wiring this file into `tsc --build` for real
  // is a separate, larger cleanup, not a one-line change.
  //
  // The runtime half of this guarantee -- that a live `ToolTx` instance
  // has no `query`/`execute`/`raw`/`sql` property -- IS actually checked,
  // above, in "exposes exactly the narrow, named operations..." (bracket
  // access, so it needs no type assertion to run). What is undocumented
  // here is only the static claim that the *type* itself has no such
  // member. Until this file is added to a tsc project, that claim rests on
  // code review, not CI.
  it.skip("compile-time only: ToolTx's type has no query method (not checked by npm test or npm run typecheck -- see comment above)", async () => {
    await withTenantTools(pool, A, async (tools: ToolTx) => {
      // @ts-expect-error -- ToolTx must never expose a way to run raw SQL text;
      // if this ever stops being a type error, the narrow interface has been
      // widened back into the thing it was built to prevent.
      tools.query;
    });
  });
});

describe("ToolTx reads", () => {
  it("reads a campaign it was scoped to open", async () => {
    const { campaignId } = await seedCampaignAndItem(A);
    const row = await withTenantTools(pool, A, (tools) => tools.readCampaign(campaignId));
    expect(row).not.toBeNull();
    expect(row?.id).toBe(campaignId);
    expect(row?.state).toBe("DRAFT");
  });

  it("does not see a campaign belonging to another workspace", async () => {
    const { campaignId } = await seedCampaignAndItem(A);
    const row = await withTenantTools(pool, B, (tools) => tools.readCampaign(campaignId));
    expect(row).toBeNull();
  });

  it("reads a content item it was scoped to open, and not one from another workspace", async () => {
    const { contentItemId } = await seedCampaignAndItem(A);
    const seenByA = await withTenantTools(pool, A, (tools) => tools.readContentItem(contentItemId));
    expect(seenByA?.id).toBe(contentItemId);

    const seenByB = await withTenantTools(pool, B, (tools) => tools.readContentItem(contentItemId));
    expect(seenByB).toBeNull();
  });
});

describe("ToolTx writes", () => {
  it("appends content versions with a server-computed, gap-free version number, and stores their citations", async () => {
    const { contentItemId } = await seedCampaignAndItem(A);

    await withTenantTools(pool, A, (tools) =>
      tools.writeContentVersion({
        contentItemId,
        body: "draft one",
        publicationContent: null,
        qualityScore: null,
        citations: [
          {
            url: "https://example.test/a",
            accessedAt: new Date("2026-08-11T00:00:00Z"),
            excerpt: "a source",
            verificationStatus: "VERIFIED",
          },
        ],
      }));

    await withTenantTools(pool, A, (tools) =>
      tools.writeContentVersion({
        contentItemId,
        body: "draft two",
        publicationContent: "final copy",
        qualityScore: 80,
        citations: [],
      }));

    const versions = await withTenantTools(pool, A, (tools) => tools.listContentVersions(contentItemId));
    expect(versions.map((v) => v.versionNumber)).toEqual([1, 2]);
    expect(versions[0]?.body).toBe("draft one");
    expect(versions[1]?.publicationContent).toBe("final copy");

    const firstVersionId = versions[0]?.id;
    if (firstVersionId === undefined) throw new Error("expected a first version");
    const citations = await withTenantTools(pool, A, (tools) => tools.listSourceCitations(firstVersionId));
    expect(citations).toHaveLength(1);
    expect(citations[0]?.url).toBe("https://example.test/a");
    expect(citations[0]?.verificationStatus).toBe("VERIFIED");
  });

  it("cannot write a content version into another workspace's content item -- RLS still applies underneath the narrow interface", async () => {
    const { contentItemId } = await seedCampaignAndItem(A);

    await expect(
      withTenantTools(pool, B, (tools) =>
        tools.writeContentVersion({
          contentItemId,
          body: "cross-tenant write attempt",
          publicationContent: null,
          qualityScore: null,
          citations: [],
        })),
    ).rejects.toThrow();

    const versions = await withTenantTools(pool, A, (tools) => tools.listContentVersions(contentItemId));
    expect(versions).toHaveLength(0);
  });
});
