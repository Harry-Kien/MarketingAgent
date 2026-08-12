// Proves the connection between the tool registry (this package) and the
// tenant boundary (@smos/db's withTenantTools / ToolTx). defineTenantTool is
// the shape proposed in task-4-report.md for "how does a handler receive
// ToolTx instead of a raw connection" given ToolContext itself has no room
// for one (workspaceId, agentRunId, allowlist only -- see tools.ts). This
// talks to the real PostgreSQL instance per STANDING-CONTEXT.md: tenant
// isolation is never mocked.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createDbPool } from "@smos/db";
import { newId, type Id } from "@smos/domain";
import { createToolRegistry, defineTenantTool } from "./tools.ts";

const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const db = createDb(pool);

const A = "77777777-7777-7777-8777-777777777777";
const B = "88888888-8888-7888-8888-888888888888";

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${A}::uuid, 'tools-tenant-A'), (${B}::uuid, 'tools-tenant-B') on conflict do nothing`,
  );
});

afterAll(async () => {
  await pool.end();
});

const ctx = (workspaceId: string) => ({ workspaceId, agentRunId: newId(), allowlist: ["read.campaign"] });

// smos_app is NOBYPASSRLS, so a bare insert with no app.workspace_id session
// variable set is refused by RLS on every tenant-owned table (goal,
// campaign, ...). @smos/db only exports withTenantTools/ToolTx publicly
// (not withTenant/TenantTx -- see tool-tx.ts's header), so seeding here
// follows the same raw set_config pattern packages/db/src/rls.test.ts uses
// for its own fixtures, on a client held for the whole insert.
async function seedCampaign(workspaceId: string): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("select set_config('app.workspace_id', $1, false)", [workspaceId]);
    const goal = await client.query(
      `insert into goal (id, workspace_id, statement) values (gen_random_uuid(), $1, 'tools-tenant probe') returning id`,
      [workspaceId],
    );
    const campaign = await client.query(
      `insert into campaign (id, workspace_id, goal_id, name, state)
       values (gen_random_uuid(), $1, $2, $3, 'DRAFT') returning id`,
      [workspaceId, (goal.rows[0] as { id: string }).id, `tools-tenant campaign ${newId()}`],
    );
    return (campaign.rows[0] as { id: string }).id;
  } finally {
    client.release();
  }
}

describe("defineTenantTool: the actual path from ToolContext to a scoped ToolTx", () => {
  it("only ever hands the handler a ToolTx (no query/execute/raw/sql), scoped by ctx.workspaceId", async () => {
    let sawKeys: string[] = [];
    const tool = defineTenantTool("read.campaign", pool, async (_args, tx) => {
      sawKeys = Object.keys(tx).sort();
      return null;
    });
    const registry = createToolRegistry([tool]);
    await registry.invoke("read.campaign", {}, ctx(A));

    expect(sawKeys).toEqual([
      "listContentVersions",
      "listSourceCitations",
      "readCampaign",
      "readContentItem",
      "writeContentVersion",
    ]);
  });

  it("a handler reads a campaign that exists in the ctx.workspaceId it was invoked with", async () => {
    const campaignId = await seedCampaign(A);

    const tool = defineTenantTool("read.campaign", pool, async (args, tx) => {
      const { campaignId: id } = args as { campaignId: Id };
      return tx.readCampaign(id);
    });
    const registry = createToolRegistry([tool]);

    const seenByA = await registry.invoke("read.campaign", { campaignId }, ctx(A));
    expect((seenByA as { id: string } | null)?.id).toBe(campaignId);
  });

  it("the SAME handler, invoked with a different ctx.workspaceId, cannot see workspace A's campaign -- the tool body never chose its own scope", async () => {
    const campaignId = await seedCampaign(A);

    // One handler, written once, with no awareness of which workspace it is
    // running for -- exactly the shape a real research/content/QA tool
    // takes. The only thing that changes between the two calls below is
    // ctx.workspaceId, supplied by the runtime, never by the handler.
    const tool = defineTenantTool("read.campaign", pool, async (args, tx) => {
      const { campaignId: id } = args as { campaignId: Id };
      return tx.readCampaign(id);
    });
    const registry = createToolRegistry([tool]);

    const seenByB = await registry.invoke("read.campaign", { campaignId }, ctx(B));
    expect(seenByB).toBeNull();
  });

  it("still refuses at the allowlist layer even for a defineTenantTool-built tool -- the tenant handle doesn't bypass the gate", async () => {
    const handlerBody = vi.fn(async () => "should never run");
    const tool = defineTenantTool("publish.meta", pool, handlerBody);
    const registry = createToolRegistry([tool]);

    await expect(registry.invoke("publish.meta", {}, { ...ctx(A), allowlist: ["read.campaign"] })).rejects.toThrow(
      /not on the tool allowlist/i,
    );
    expect(handlerBody).not.toHaveBeenCalled();
  });
});
