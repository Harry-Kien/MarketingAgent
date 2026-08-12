// P4 Task 8: Golden Sequence proof (E6, E12) -- goal to published post to
// measured result, traceable end to end, against the real PostgreSQL on
// 5433, the real fake Meta sandbox server, and no real network egress or
// credential, ever. See apps/web/e2e/fixtures/seed.ts's header for why this
// is a vitest integration test rather than a Playwright spec.
//
// "The Golden Sequence must be able to FAIL": after the happy path is
// green, five separate tests each deliberately break exactly one middle
// step -- the approval, the publish gate (content-hash drift), the egress
// guard, the output contract, and the audit chain -- and assert the
// sequence genuinely fails for each. A sequence that stays green with a
// middle step broken would prove nothing.
import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@smos/domain";
import { createDbPool, traceToGoal } from "@smos/db";
import { startFakeMetaServer, createMetaAdapter, AdapterError, type FakeMetaServer } from "@smos/integrations";
import {
  seedWorkspace,
  seedAgentRegistry,
  runContentPipeline,
  createApprovalRequest,
  recordHumanDecision,
  insertPreparedPublication,
  insertRevisedContentVersion,
  publishToSandbox,
  readPublicationState,
  ingestSandboxEvent,
  cleanupWorkspace,
  TARGET_CHANNEL,
  SANDBOX_PAGE_ID,
  PUBLICATION_CONTENT,
  type GoldenWorkspace,
} from "./fixtures/seed.ts";

const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);

const workspacesToClean: Array<GoldenWorkspace["workspaceId"]> = [];

afterAll(async () => {
  for (const workspaceId of workspacesToClean) {
    await cleanupWorkspace(adminPool, workspaceId).catch(() => undefined);
  }
  await pool.end();
  await adminPool.end();
});

async function newWorkspace() {
  const ws = await seedWorkspace(adminPool);
  workspacesToClean.push(ws.workspaceId);
  const registry = await seedAgentRegistry(adminPool, ws.workspaceId);
  return { ws, registry };
}

async function withSandboxServer<T>(fn: (server: FakeMetaServer) => Promise<T>): Promise<T> {
  const server = await startFakeMetaServer();
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

function sandboxAdapter(server: FakeMetaServer, allowedHosts?: string[]) {
  return createMetaAdapter(
    {
      baseUrl: server.url,
      pageId: SANDBOX_PAGE_ID,
      token: "sandbox-token",
      allowedHosts: allowedHosts ?? [new URL(server.url).hostname],
    },
    server.fetchImpl,
  );
}

describe("Golden Sequence", () => {
  it(
    "goal to published post to measured result, traceable end to end (E6, E12)",
    async () => {
      const { ws, registry } = await newWorkspace();

      // 1-4: orchestrator -> research -> content -> qa_brand_safety, all
      // through the real runAgent runtime and the real fake provider.
      const pipeline = await runContentPipeline(pool, ws, registry);
      expect(pipeline.qaVerdict).toBe("pass");

      // 5: the founder's Approval Center would show this request. A real
      // human approval decision, through the real domain gate.
      const approvalRequestId = await createApprovalRequest(pool, ws, {
        contentVersionId: pipeline.contentVersionId,
      });
      const approvalDecisionId = await recordHumanDecision(pool, ws, {
        approvalRequestId,
        contentVersionId: pipeline.contentVersionId,
        citationIds: pipeline.citationIds,
        decision: "approve",
        reason: "Nội dung đã có bằng chứng xác thực và đúng giọng thương hiệu.",
      });

      // 6: sandbox publish -- never the real Meta, never a real credential.
      const publicationId = await insertPreparedPublication(pool, ws, {
        contentVersionId: pipeline.contentVersionId,
        publicationContent: pipeline.publicationContent,
        approvalDecisionId,
      });

      await withSandboxServer(async (server) => {
        await publishToSandbox(pool, ws, publicationId, sandboxAdapter(server));

        const afterPublish = await readPublicationState(pool, ws, publicationId);
        expect(afterPublish.state).toBe("succeeded");
        expect(afterPublish.externalId).toMatch(new RegExp(`^${SANDBOX_PAGE_ID}_`));

        // 7: a sandbox engagement event arrives and updates analytics.
        await ingestSandboxEvent(pool, ws, {
          externalId: afterPublish.externalId!,
          eventType: "post.impression",
          value: 512,
          occurredAt: new Date().toISOString(),
          deliveryId: `delivery-${newId()}`,
        });
      });

      // 8 (E12): the audit chain walks all the way back to the goal, and
      // carries both the approval and the publish success as real events.
      const chain = await traceToGoal(pool, ws.workspaceId, publicationId);
      expect(chain.goalId).toBe(ws.goalId);
      expect(chain.approvalDecisionId).toBe(approvalDecisionId);
      const eventTypes = chain.auditEvents.map((e) => e.eventType);
      expect(eventTypes).toEqual(expect.arrayContaining(["approval.granted", "publication.succeeded"]));
    },
    30_000,
  );

  // --- Deliberate breaks: the sequence must fail for each. -----------------

  it("BREAK 1/5 (approval): a real human REJECTION must stop publishing, not merely a missing decision", async () => {
    const { ws, registry } = await newWorkspace();
    const pipeline = await runContentPipeline(pool, ws, registry);
    const approvalRequestId = await createApprovalRequest(pool, ws, { contentVersionId: pipeline.contentVersionId });
    // A real human explicitly says no.
    const approvalDecisionId = await recordHumanDecision(pool, ws, {
      approvalRequestId,
      contentVersionId: pipeline.contentVersionId,
      citationIds: pipeline.citationIds,
      decision: "reject",
      reason: "Chưa đủ bằng chứng để đăng ngay.",
    });
    const publicationId = await insertPreparedPublication(pool, ws, {
      contentVersionId: pipeline.contentVersionId,
      publicationContent: pipeline.publicationContent,
      approvalDecisionId,
    });

    await withSandboxServer(async (server) => {
      await expect(publishToSandbox(pool, ws, publicationId, sandboxAdapter(server))).rejects.toThrow(/approved/i);
      const state = await readPublicationState(pool, ws, publicationId);
      expect(state.state).toBe("prepared"); // never advanced
      expect(state.externalId).toBeNull();
      expect(server.posts.size).toBe(0); // the adapter was never actually called
    });
  });

  it("BREAK 2/5 (publish gate): a publication built for a newer, un-approved content version must be refused", async () => {
    const { ws, registry } = await newWorkspace();
    const pipeline = await runContentPipeline(pool, ws, registry);
    const approvalRequestId = await createApprovalRequest(pool, ws, { contentVersionId: pipeline.contentVersionId });
    // The founder approves version 1...
    const approvalDecisionId = await recordHumanDecision(pool, ws, {
      approvalRequestId,
      contentVersionId: pipeline.contentVersionId,
      citationIds: pipeline.citationIds,
      decision: "approve",
      reason: "Nội dung đạt yêu cầu.",
    });

    // ...but a later edit produces version 2, never itself approved.
    // `publication`'s content-bearing columns are immutable at the database
    // (0011_publication_immutability.sql), so a real publication row can
    // never be tampered into disagreeing with itself after insert -- the
    // real way content drifts out from under an approval is a publish that
    // targets a newer version than what was actually reviewed.
    const revisedText = "Bản chỉnh sửa sau khi duyệt: ưu đãi mới chưa từng được rà soát.";
    const revisedVersionId = await insertRevisedContentVersion(pool, ws, {
      contentItemId: pipeline.contentItemId,
      nextVersionNumber: 2,
      body: revisedText,
      publicationContent: revisedText,
    });
    const publicationId = await insertPreparedPublication(pool, ws, {
      contentVersionId: revisedVersionId, // NOT what approvalDecisionId actually covers
      publicationContent: revisedText,
      approvalDecisionId,
    });

    await withSandboxServer(async (server) => {
      await expect(publishToSandbox(pool, ws, publicationId, sandboxAdapter(server))).rejects.toThrow(/content version/i);
      const state = await readPublicationState(pool, ws, publicationId);
      expect(state.state).toBe("prepared"); // never advanced
      expect(server.posts.size).toBe(0); // the adapter was never actually called
    });
  });

  it("BREAK 3/5 (egress guard): an adapter not allowed to reach the sandbox host must be refused before any post is created", async () => {
    const { ws, registry } = await newWorkspace();
    const pipeline = await runContentPipeline(pool, ws, registry);
    const approvalRequestId = await createApprovalRequest(pool, ws, { contentVersionId: pipeline.contentVersionId });
    const approvalDecisionId = await recordHumanDecision(pool, ws, {
      approvalRequestId,
      contentVersionId: pipeline.contentVersionId,
      citationIds: pipeline.citationIds,
      decision: "approve",
      reason: "Nội dung đạt yêu cầu.",
    });
    const publicationId = await insertPreparedPublication(pool, ws, {
      contentVersionId: pipeline.contentVersionId,
      publicationContent: pipeline.publicationContent,
      approvalDecisionId,
    });

    await withSandboxServer(async (server) => {
      // The allowlist deliberately excludes the sandbox's own host: this is
      // the egress guard (assertEgressAllowed / guardedFetch), not the
      // approval gate, being exercised.
      const adapter = sandboxAdapter(server, ["not-the-sandbox-host.test"]);
      const result = await publishToSandbox(pool, ws, publicationId, adapter).then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
      expect(result).toBeInstanceOf(AdapterError);
      expect((result as AdapterError).kind).toBe("permanent_rejection");
      const state = await readPublicationState(pool, ws, publicationId);
      expect(state.state).toBe("failed"); // markFailed ran; publish never reached the fake server
      expect(state.externalId).toBeNull();
      expect(server.posts.size).toBe(0);
    });
  });

  it("BREAK 4/5 (output contract): a QA response that fails schema validation must stop the sequence before any approval request exists", async () => {
    const { ws, registry } = await newWorkspace();
    await expect(runContentPipeline(pool, ws, registry, { breakQaOutputContract: true })).rejects.toThrow(
      /schema validation|not valid json/i,
    );

    // Nothing downstream was ever created for this workspace.
    const approvalRequests = await adminPool.query(`select count(*)::int as n from approval_request where workspace_id = $1`, [
      ws.workspaceId,
    ]);
    expect((approvalRequests.rows[0] as { n: number }).n).toBe(0);
    const publications = await adminPool.query(`select count(*)::int as n from publication where workspace_id = $1`, [
      ws.workspaceId,
    ]);
    expect((publications.rows[0] as { n: number }).n).toBe(0);
  });

  it("BREAK 5/5 (audit chain): a decision that is never audited must leave the trace visibly incomplete, not silently patched over", async () => {
    const { ws, registry } = await newWorkspace();
    const pipeline = await runContentPipeline(pool, ws, registry);
    const approvalRequestId = await createApprovalRequest(pool, ws, { contentVersionId: pipeline.contentVersionId });
    const approvalDecisionId = await recordHumanDecision(pool, ws, {
      approvalRequestId,
      contentVersionId: pipeline.contentVersionId,
      citationIds: pipeline.citationIds,
      decision: "approve",
      reason: "Nội dung đạt yêu cầu.",
      skipAudit: true, // the break: a real decision, but no audit_log row for it
    });
    const publicationId = await insertPreparedPublication(pool, ws, {
      contentVersionId: pipeline.contentVersionId,
      publicationContent: pipeline.publicationContent,
      approvalDecisionId,
    });

    await withSandboxServer(async (server) => {
      // Publishing itself still succeeds -- this break is specifically about
      // the audit trail, not the publish gate.
      await publishToSandbox(pool, ws, publicationId, sandboxAdapter(server));
    });

    const chain = await traceToGoal(pool, ws.workspaceId, publicationId);
    const eventTypes = chain.auditEvents.map((e) => e.eventType);
    // The E12 acceptance bar from the happy path -- both events present --
    // now genuinely fails: the trace faithfully reports the gap instead of
    // rendering the chain as if the approval had been audited.
    expect(eventTypes).not.toContain("approval.granted");
    expect(eventTypes).toContain("publication.succeeded");
  });
});
