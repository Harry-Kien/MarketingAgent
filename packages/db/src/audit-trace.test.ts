// E12: given a publication id, walk the whole chain back to the business
// goal that produced it -- approval decision, approval request, content
// version, content item, campaign, goal -- and every audit_log row attached
// to any id in that chain, in chronological order. This is the audit claim
// the milestone rests on: any external action can be traced to the decision
// that authorised it.
//
// Reuses seedTwoWorkspaces (@smos/testing) rather than hand-building
// fixtures -- it already seeds one fully-populated, valid publication per
// workspace, wired together with real foreign keys, using unique
// `e12-<label>-<workspaceId>` literal names per call (see
// packages/testing/src/tenant-fixtures.ts), so nothing here needs its own
// suffix scheme for the base chain.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@smos/domain";
import { seedTwoWorkspaces, type TenantFixture } from "@smos/testing";
import { createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";
import { traceToGoal } from "./audit-trace.ts";

// smos_app: the non-BYPASSRLS application role (ADR-007) -- every call to
// traceToGoal in this file goes through this pool.
const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
// smos: the migration-owner superuser, which always bypasses RLS. Used only
// for seeding fixtures, never for a traceToGoal call itself.
const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const adminPool = createDbPool(adminUrl);

let a: TenantFixture;
let b: TenantFixture;

beforeAll(async () => {
  ({ a, b } = await seedTwoWorkspaces(adminPool));
});

afterAll(async () => {
  // Best-effort cleanup, same constraint documented in cross-tenant.test.ts:
  // goal/campaign/content_item/content_version/approval_request/publication
  // cannot be deleted here because approval_decision and audit_log are
  // immutable-by-trigger (0007_approval.sql, 0001_core_tenancy.sql) and sit
  // in their plain-FK ancestry with no ON DELETE CASCADE. What IS safely
  // deletable (nothing else references it) is removed so this suite's
  // footprint stays bounded to what the schema actually allows. audit_log
  // rows this file inserts are never deleted -- they are append-only by
  // design (two independent mechanisms: trigger + revoked grants) -- and are
  // left as permanent, harmlessly-named e12-suffixed seed data, exactly like
  // every other suite that writes to this table.
  for (const ws of [a, b].filter((w): w is TenantFixture => w !== undefined)) {
    await adminPool.query("delete from agent_version where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from agent_definition where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from outbox where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
  }
  await pool.end();
  await adminPool.end();
});

describe("E12: traceToGoal", () => {
  it("walks the full chain: decision, request, content version, item, campaign, goal", async () => {
    const chain = await traceToGoal(pool, a.workspaceId, a.publicationId);
    expect(chain.publicationId).toBe(a.publicationId);
    expect(chain.approvalDecisionId).toBe(a.approvalDecisionId);
    expect(chain.approvalRequestId).toBe(a.approvalRequestId);
    expect(chain.contentVersionId).toBe(a.contentVersionId);
    expect(chain.contentItemId).toBe(a.contentItemId);
    expect(chain.campaignId).toBe(a.campaignId);
    expect(chain.goalId).toBe(a.goalId);
  });

  it("a publication in another workspace is not found -- indistinguishable from a genuinely missing id", async () => {
    const crossWorkspace = await traceToGoal(pool, b.workspaceId, a.publicationId).catch((e: unknown) => e);
    const genuinelyMissing = await traceToGoal(pool, b.workspaceId, newId()).catch((e: unknown) => e);

    expect(crossWorkspace).toBeInstanceOf(Error);
    expect(genuinelyMissing).toBeInstanceOf(Error);
    expect((crossWorkspace as Error).message).toMatch(/not found/i);
    // Same message for both -- no branch anywhere reveals that a.publicationId
    // actually exists, just in a workspace b cannot see (T6: no existence leak).
    expect((crossWorkspace as Error).message).toBe((genuinelyMissing as Error).message);
  });

  it("returns audit events attached to the chain in chronological order", async () => {
    const suffix = `e12-trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const secondId = newId();
    const firstId = newId();

    // Inserted out of chronological order on purpose: the later-occurring
    // event is written first, the earlier-occurring event second, with
    // explicit occurred_at timestamps an hour apart -- so a query that
    // merely returned insertion order would fail this assertion.
    await withTenant(pool, a.workspaceId, (tx) =>
      tx.query(
        `insert into audit_log (id, workspace_id, event_type, actor_kind, subject_type, subject_id, occurred_at)
         values ($1, $2, $3, 'system', 'publication', $4, now())`,
        [secondId, a.workspaceId, `${suffix}.second`, a.publicationId],
      ));
    await withTenant(pool, a.workspaceId, (tx) =>
      tx.query(
        `insert into audit_log (id, workspace_id, event_type, actor_kind, subject_type, subject_id, occurred_at)
         values ($1, $2, $3, 'system', 'campaign', $4, now() - interval '1 hour')`,
        [firstId, a.workspaceId, `${suffix}.first`, a.campaignId],
      ));

    const chain = await traceToGoal(pool, a.workspaceId, a.publicationId);
    const ours = chain.auditEvents.filter((e) => e.eventType.startsWith(suffix));
    expect(ours.map((e) => e.eventType)).toEqual([`${suffix}.first`, `${suffix}.second`]);
  });

  it("a chain with no audit events still resolves the ids rather than throwing", async () => {
    // b's fixture publication has no audit_log row whose subject_id matches
    // any id in its own chain (seedOne's own audit row targets no subject at
    // all), and this file never attaches one -- b's chain is the "quiet"
    // case beside a's "has events" case above.
    const chain = await traceToGoal(pool, b.workspaceId, b.publicationId);
    expect(chain.publicationId).toBe(b.publicationId);
    expect(chain.goalId).toBe(b.goalId);
    expect(chain.auditEvents).toEqual([]);
  });
});
