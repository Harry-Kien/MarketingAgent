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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@smos/domain";
import { createDbPool, traceToGoal } from "@smos/db";
import { startFakeMetaServer, createMetaAdapter, AdapterError, type FakeMetaServer } from "@smos/integrations";
import {
  seedWorkspace,
  seedAgentRegistry,
  runContentPipeline,
  createApprovalRequest,
  configureChannel,
  readIntegrationStatus,
  markChannelSandboxVerified,
  recordHumanDecision,
  recordHumanDecisionViaWebLayer,
  recordHumanDecisionViaSubmitApproval,
  readApprovalDecision,
  readAgentRunRoles,
  readContentVersion,
  insertPreparedPublication,
  insertRevisedContentVersion,
  publishToSandbox,
  readPublicationState,
  ingestSandboxEventViaWebhook,
  ingestSandboxEventWithForeignSignature,
  readIngestedEvidence,
  cleanupWorkspace,
  TARGET_CHANNEL,
  SANDBOX_PAGE_ID,
  PUBLICATION_CONTENT,
  type GoldenWorkspace,
} from "./fixtures/seed.ts";
import { seedWorkspaceWithLogin, cleanupAuthWorkspace, type AuthSeededWorkspace } from "./fixtures/auth-seed.ts";

const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);

const workspacesToClean: Array<GoldenWorkspace["workspaceId"]> = [];
// Hardening task 2: workspaces seeded WITH a real login (real user_account +
// workspace_member + hashed password credential) so the happy path can sign
// in for real -- tracked separately because they need `workspace_member`
// cleaned up too (cleanupWorkspace alone never touches that table).
const authWorkspacesToClean: AuthSeededWorkspace[] = [];

// Step 7 goes through the real webhook route. Credential vault task: there
// is no fleet-wide root secret to configure anymore -- the route resolves
// (and, on first use, provisions) each workspace's own secret from the
// vault via server/webhook-secret.ts, which ingestSandboxEventViaWebhook
// (fixtures/seed.ts) reads through the identical call. Nothing real is
// ever contacted; the vault itself points at the same sandbox PostgreSQL
// every other test in this suite uses.
//
// BREAK 7 sends exactly one deliberately-invalid signature through the real
// route, which increments webhook-rate-limit.ts's `invalid_global` scope --
// a single shared row (bucket_index always 0) that route.test.ts's own
// suite, and webhook-rate-limit.test.ts's suite, also touch. Reproduced
// live: whichever of those files happens to run first within the same
// 60-second window can leave that one row already past its production
// ceiling, turning BREAK 7's expected 401 into a 429 for a reason that has
// nothing to do with this sequence's own correctness. Reset here, same
// reasoning as route.test.ts's own beforeAll.
beforeAll(async () => {
  await adminPool.query("delete from webhook_rate_limit_bucket where scope = 'invalid_global'");
});

afterAll(async () => {
  for (const workspaceId of workspacesToClean) {
    await cleanupWorkspace(adminPool, workspaceId).catch(() => undefined);
  }
  for (const ws of authWorkspacesToClean) {
    await cleanupAuthWorkspace(adminPool, ws).catch(() => undefined);
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

/** Hardening task 2: a workspace that can actually sign in for real, so the
 * happy path can drive `submitApproval`'s own session resolution instead of
 * injecting a trusted `{userId, workspaceId}` directly. */
async function newLoginableWorkspace() {
  const ws = await seedWorkspaceWithLogin(adminPool, "golden-sequence");
  workspacesToClean.push(ws.workspaceId);
  authWorkspacesToClean.push(ws);
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
      const { ws, registry } = await newLoginableWorkspace();

      // 1-4: orchestrator -> research -> content -> qa_brand_safety, all
      // through the real runAgent runtime and the real fake provider.
      const pipeline = await runContentPipeline(pool, ws, registry);
      expect(pipeline.qaVerdict).toBe("pass");
      // ...and each of those four agent runs really executed and really
      // succeeded, rather than the pipeline merely returning a shaped object.
      expect(await readAgentRunRoles(pool, ws)).toEqual([
        "content",
        "orchestrator",
        "qa_brand_safety",
        "research",
      ]);
      // ...and the content it produced is really persisted, with evidence.
      const contentVersion = await readContentVersion(pool, ws, pipeline.contentVersionId);
      expect(contentVersion.publicationContent).toBe(PUBLICATION_CONTENT);
      expect(contentVersion.citationCount).toBe(pipeline.citationIds.length);
      expect(contentVersion.citationCount).toBeGreaterThan(0);

      // 5: the founder configures the Meta channel, then decides. Hardening
      // task 2: the decision now goes through the real `submitApproval`
      // Server Action's own logic -- a real password sign-in, a real
      // session cookie, the real requireWorkspace()-equivalent session
      // resolution, real FormData -- not merely `performApproval` in
      // isolation (late-review IMPORTANT 6 got the sequence as far as
      // performApproval; that report's own concern (5) is what this closes).
      const approvalRequestId = await createApprovalRequest(pool, ws, {
        contentVersionId: pipeline.contentVersionId,
      });
      await configureChannel(pool, ws);
      const approvalDecisionId = await recordHumanDecisionViaSubmitApproval(ws, {
        approvalRequestId,
        decision: "approve",
        reason: "Nội dung đã có bằng chứng xác thực và đúng giọng thương hiệu.",
      });
      const decisionRow = await readApprovalDecision(pool, ws, approvalDecisionId);
      expect(decisionRow.decision).toBe("approve");
      expect(decisionRow.actorUserId).toBe(ws.userId);
      // CRITICAL 1: the decision records WHAT it approved on its own
      // immutable row, not by pointing at a request that can be retargeted.
      expect(decisionRow.contentVersionId).toBe(pipeline.contentVersionId);
      expect(decisionRow.targetChannel).toBe(TARGET_CHANNEL);

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
        // The post really exists on the sandbox, carrying the approved text.
        expect(server.posts.size).toBe(1);

        // Only NOW can the channel claim to be sandbox-verified, and only by
        // naming the publication that earned it (late-review IMPORTANT 3).
        await markChannelSandboxVerified(pool, ws, publicationId);
        expect(await readIntegrationStatus(pool, ws)).toBe("sandbox");

        // 7: a sandbox engagement event arrives -- through the REAL webhook
        // route, with a real workspace-bound signature over a real streamed
        // body, not by calling the handler directly.
        const status = await ingestSandboxEventViaWebhook(ws, {
          externalId: afterPublish.externalId!,
          eventType: "post.impression",
          value: 512,
          occurredAt: new Date().toISOString(),
          deliveryId: `delivery-${newId()}`,
        });
        expect(status).toBe(200);
      });

      // ...and step 7 actually produced something. Asserting this is what
      // makes the sequence able to fail at all: with `return;` at the top of
      // handleIngestEvent -- the reviewer's mutation, which left this test
      // fully green -- all three collections below are empty.
      const evidence = await readIngestedEvidence(pool, ws);
      expect(evidence.deliveries).toEqual([
        { externalId: expect.stringMatching(/^delivery-/), signatureOk: true },
      ]);
      expect(evidence.events).toEqual([{ eventType: "post.impression", publicationId, value: 512 }]);
      expect(evidence.metrics).toEqual([
        {
          name: "reach",
          value: "512",
          confidence: "medium",
          attributionModel: "last_touch",
          attributionWindow: "7d",
        },
      ]);

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

  // Late-review IMPORTANT 6: two more breaks, both of them CODE-path
  // failures rather than the data variations BREAKs 1-5 are. BREAK 6 breaks
  // the web layer's own gate (which the sequence never touched before);
  // BREAK 7 breaks the wire the measurement arrives on.
  it("BREAK 6/7 (channel gate): approving for a channel that is not connected must be refused at the web layer", async () => {
    const { ws, registry } = await newWorkspace();
    const pipeline = await runContentPipeline(pool, ws, registry);
    const approvalRequestId = await createApprovalRequest(pool, ws, { contentVersionId: pipeline.contentVersionId });
    // configureChannel is deliberately NOT called: no integration row exists.
    await expect(
      recordHumanDecisionViaWebLayer(pool, ws, {
        approvalRequestId,
        decision: "approve",
        reason: "Duyệt dù kênh chưa kết nối.",
      }),
    ).rejects.toThrow();

    const decisions = await adminPool.query(
      `select count(*)::int as n from approval_decision where workspace_id = $1`,
      [ws.workspaceId],
    );
    expect((decisions.rows[0] as { n: number }).n).toBe(0);
  });

  it("BREAK 7/7 (measurement wire): a delivery whose signature is not bound to this workspace must measure nothing", async () => {
    const { ws, registry } = await newWorkspace();
    const pipeline = await runContentPipeline(pool, ws, registry);
    const approvalRequestId = await createApprovalRequest(pool, ws, { contentVersionId: pipeline.contentVersionId });
    await configureChannel(pool, ws);
    const approvalDecisionId = await recordHumanDecisionViaWebLayer(pool, ws, {
      approvalRequestId,
      decision: "approve",
      reason: "Nội dung đạt yêu cầu.",
    });
    const publicationId = await insertPreparedPublication(pool, ws, {
      contentVersionId: pipeline.contentVersionId,
      publicationContent: pipeline.publicationContent,
      approvalDecisionId,
    });

    await withSandboxServer(async (server) => {
      await publishToSandbox(pool, ws, publicationId, sandboxAdapter(server));
      const afterPublish = await readPublicationState(pool, ws, publicationId);

      // Signed under the ROOT secret rather than this workspace's derived
      // one -- precisely the cross-tenant replay CRITICAL 2 closed.
      const status = await ingestSandboxEventWithForeignSignature(ws, {
        externalId: afterPublish.externalId!,
        eventType: "post.impression",
        value: 512,
        occurredAt: new Date().toISOString(),
        deliveryId: `delivery-${newId()}`,
      });
      expect(status).toBe(401);
    });

    const evidence = await readIngestedEvidence(pool, ws);
    expect(evidence.events).toEqual([]);
    expect(evidence.metrics).toEqual([]);
    // ...and the rejected delivery left an honest receipt without consuming
    // the delivery id it claimed.
    expect(evidence.deliveries.every((d) => !d.signatureOk)).toBe(true);
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
