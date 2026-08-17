// Golden Sequence backend fixture (P4 Task 8, evidence E6/E12).
//
// Why this is not a Playwright spec: `apps/web/src/server/auth.ts`'s
// `requireWorkspace()` is a documented stub that always throws
// `UnauthorizedError` until a real session backend lands (pending
// better-auth + a users/workspace_members schema from another track) -- see
// that file's own header. Every real (app) route sits behind it, so a
// browser session cannot reach the Approval Center, a campaign page, or
// /analytics today; P3's own a11y/keyboard evidence task (commit a5cf5b4)
// already reached and documented the identical conclusion and built a
// component-harness substitute instead of adding @playwright/test for that
// reason. This fixture takes the other approach the task brief explicitly
// allows: drive the REAL modules -- runAgent, the model gateway with the
// deterministic fake provider, evaluateGate, decideApproval, handlePublish,
// the fake Meta server, handleIngestEvent, traceToGoal -- directly, against
// the real PostgreSQL on 5433, with no browser and no new dependency. It is
// faster than a browser and, because every step is independently callable,
// it is what makes "break one middle step and confirm the whole sequence
// fails" (the task's own falsifiability requirement) straightforward to
// prove five separate ways.
//
// Every write here goes through `withTenant` (RLS-scoped, as smos_app) or
// the admin/migration pool for rows only a superuser-equivalent role may
// seed directly (workspace, user_account, goal, campaign, agent_definition,
// agent_version) -- exactly the split every other integration test in this
// repository already uses (packages/agents/src/runtime-db.test.ts,
// packages/db/src/cross-tenant.test.ts).
import { createHmac } from "node:crypto";
import type pg from "pg";
import {
  newId,
  type Id,
  createCampaign,
  createContentItem,
  addVersion,
  decideApproval,
  buildPublication,
  ALL_AGENT_ROLES,
  M1_ACTIVATED_AGENTS,
  type AgentRegistryEntry,
  type ApprovalRequest,
  type ApprovalDecisionKind,
  type ContentVersion,
  type SourceCitation,
} from "@smos/domain";
import { withTenant, createRunStore } from "@smos/db";
import { createFakeProvider, createGateway } from "@smos/model-gateway";
import {
  runAgent,
  createToolRegistry,
  orchestratorAgent,
  researchAgent,
  contentAgent,
  qaAgent,
} from "@smos/agents";
import { evaluateGate, trustActionKind } from "@smos/policy";
import {
  handlePublish,
  handleIngestEvent,
  type PublishDeps,
  type PublicationRecord,
  type LoadedApprovalDecision,
  type IngestEventDeps,
  type IngestEventPayload,
} from "@smos/worker";
import type { ChannelAdapter } from "@smos/integrations";
import { performApproval, type PerformApprovalDeps } from "../../src/server/actions/approve.ts";
import { parseApprovalFormData, recordApprovalDecision } from "../../src/server/actions/submit-approval.ts";
import { isChannelConnected, providerForChannel } from "../../src/server/channel-status.ts";
import { recordSandboxVerification } from "../../src/server/integration-verification.ts";
import { getWorkspaceWebhookSecret } from "../../src/server/webhook-secret.ts";
import { auth, buildSessionDeps } from "../../src/server/auth.ts";
import { resolveWorkspace } from "../../src/server/session.ts";

export const TARGET_CHANNEL = "meta_page";
export const SANDBOX_PAGE_ID = "page-1";

export interface GoldenWorkspace {
  workspaceId: Id;
  userId: Id;
  goalId: Id;
  campaignId: Id;
}

const GOAL_STATEMENT = "Tăng nhận diện thương hiệu cho sản phẩm mới trong quý này";
const BRAND_VOICE = "Thân thiện, đáng tin cậy, nói tiếng Việt tự nhiên";
const CITATION_URL = "https://example.com/khao-sat-thi-truong-2026";
const CITATION_EXCERPT = "Khảo sát nội bộ quý này cho thấy 68% người được hỏi ưu tiên giao hàng nhanh.";
export const PUBLICATION_CONTENT =
  "Ra mắt sản phẩm mới: giao hàng nhanh trong 24 giờ, đặt hàng ngay hôm nay.";
const ALLOWED_CLAIM = "giao hàng nhanh trong 24 giờ";

/** Seeds one workspace, founder user, goal and DRAFT campaign directly via
 * the admin/migration pool -- mirrors packages/agents/src/runtime-db.test.ts's
 * own beforeAll seeding exactly. */
export async function seedWorkspace(adminPool: pg.Pool): Promise<GoldenWorkspace> {
  const workspaceId = newId();
  const userId = newId();
  const goalId = newId();

  await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [
    workspaceId,
    `golden-sequence-${workspaceId}`,
  ]);
  await adminPool.query(`insert into user_account (id, email, name) values ($1, $2, $3)`, [
    userId,
    `golden-sequence-${workspaceId}@test.local`,
    "Người sáng lập",
  ]);
  await adminPool.query(`insert into goal (id, workspace_id, statement) values ($1, $2, $3)`, [
    goalId,
    workspaceId,
    GOAL_STATEMENT,
  ]);

  const { campaign } = createCampaign({
    workspaceId,
    goalId,
    name: `Golden Sequence ${workspaceId}`,
    actor: { kind: "system", reason: "golden sequence fixture seed" },
    correlationId: newId(),
  });
  await adminPool.query(
    `insert into campaign (id, workspace_id, goal_id, name, state, version) values ($1, $2, $3, $4, $5, $6)`,
    [campaign.id, workspaceId, goalId, campaign.name, campaign.state, campaign.version],
  );

  return { workspaceId, userId, goalId, campaignId: campaign.id };
}

/** One real, activated `AgentRegistryEntry` per M1_ACTIVATED_AGENTS role,
 * backed by real agent_definition/agent_version rows -- exactly what
 * `assertActivated` (packages/domain/src/agent-registry.ts) and the
 * database's own activation-gate trigger (0025_agent_run_activation_gate.sql)
 * both check before `runAgent` is allowed to spend anything. */
export async function seedAgentRegistry(adminPool: pg.Pool, workspaceId: Id): Promise<AgentRegistryEntry[]> {
  const entries: AgentRegistryEntry[] = [];
  for (const role of ALL_AGENT_ROLES) {
    const activated = (M1_ACTIVATED_AGENTS as readonly string[]).includes(role);
    const versionId = newId();
    if (activated) {
      const definitionId = newId();
      await adminPool.query(
        `insert into agent_definition (id, workspace_id, role, mission) values ($1, $2, $3, $4)`,
        [definitionId, workspaceId, role, `golden sequence ${role}`],
      );
      await adminPool.query(
        `insert into agent_version (id, workspace_id, agent_definition_id, version_number, activated, prompt_version, model_version, budget_usd)
         values ($1, $2, $3, 1, true, 'p1', 'fake-1', 5.0)`,
        [versionId, workspaceId, definitionId],
      );
    }
    entries.push({ role, versionId, activated, toolAllowlist: [], prohibitedActions: [] });
  }
  return entries;
}

export interface ContentPipelineOptions {
  /** Breaks the output-contract boundary: the QA agent's scripted response
   * fails `qaOutputSchema` (packages/contracts/src/agent-output.ts), so
   * `runAgent` throws inside `qaAgent.parse` before an ApprovalRequest or
   * Publication is ever created. */
  breakQaOutputContract?: boolean;
}

export interface ContentPipelineResult {
  contentItemId: Id;
  contentVersionId: Id;
  citationIds: Id[];
  publicationContent: string;
  qaVerdict: "pass" | "block";
}

/** Runs all four M1 agents (orchestrator -> research -> content ->
 * qa_brand_safety) through the REAL `runAgent` runtime, the REAL budget-
 * enforced gateway, and the REAL deterministic fake provider -- one shared
 * gateway/provider instance across all four calls, since each role uses a
 * distinct `schemaName` key. Persists the resulting content_item /
 * content_version / source_citation rows, then runs the REAL `evaluateGate`
 * policy check that publishing to a real channel always requires approval. */
export async function runContentPipeline(
  pool: pg.Pool,
  ws: GoldenWorkspace,
  registry: AgentRegistryEntry[],
  opts: ContentPipelineOptions = {},
): Promise<ContentPipelineResult> {
  const orchestratorOutput = {
    tasks: [
      { role: "research" as const, instruction: "Tìm bằng chứng thị trường cho sản phẩm mới", dependsOn: [] },
      { role: "content" as const, instruction: "Viết bài đăng ra mắt sản phẩm", dependsOn: [0] },
      { role: "qa_brand_safety" as const, instruction: "Kiểm tra bài đăng trước khi trình duyệt", dependsOn: [1] },
    ],
  };

  const accessedAtIso = new Date().toISOString();
  const researchOutput = {
    findings: [
      {
        claim: "68% khách hàng mục tiêu quan tâm đến tính năng giao hàng nhanh",
        verificationStatus: "VERIFIED" as const,
        citations: [{ url: CITATION_URL, accessedAt: accessedAtIso, excerpt: CITATION_EXCERPT }],
      },
    ],
  };

  const contentOutput = {
    body: "Bản nháp: giới thiệu sản phẩm mới, tập trung vào tốc độ giao hàng.",
    publicationContent: PUBLICATION_CONTENT,
    claimsUsed: [ALLOWED_CLAIM],
  };

  const validQaOutput = {
    verdict: "pass" as const,
    qualityScore: 92,
    findings: [] as Array<{ severity: "info" | "warn" | "block"; message: string }>,
  };
  // A response that fails qaOutputSchema: qualityScore is a string, not the
  // required 0-100 integer, and "maybe-pass" is not in the closed
  // verdict enum -- parseAgentOutput must reject it outright, never coerce.
  const brokenQaResponse = '{"verdict":"maybe-pass","qualityScore":"not-a-number","findings":[]}';

  const provider = createFakeProvider({
    "orchestrator.v1": JSON.stringify(orchestratorOutput),
    "research.v1": JSON.stringify(researchOutput),
    "content.v1": JSON.stringify(contentOutput),
    "qa.v1": opts.breakQaOutputContract === true ? brokenQaResponse : JSON.stringify(validQaOutput),
  });
  const gateway = createGateway({ provider, budgetUsd: 5, maxWallclockMs: 5000, estimatedCostUsd: 0.05 });
  const store = createRunStore(pool, ws.workspaceId);
  const tools = createToolRegistry([]);

  await runAgent({
    role: "orchestrator",
    registry,
    gateway,
    tools,
    workspaceId: ws.workspaceId,
    campaignId: ws.campaignId,
    correlationId: newId(),
    buildPrompt: () => orchestratorAgent.buildPrompt({ goal: GOAL_STATEMENT, brandVoice: BRAND_VOICE }),
    parse: (raw) => orchestratorAgent.parse(raw),
    store,
  });

  await runAgent({
    role: "research",
    registry,
    gateway,
    tools,
    workspaceId: ws.workspaceId,
    campaignId: ws.campaignId,
    correlationId: newId(),
    buildPrompt: () =>
      researchAgent.buildPrompt({
        topic: "sản phẩm mới",
        brandVoice: BRAND_VOICE,
        externalSources: [{ url: CITATION_URL, accessedAt: new Date(accessedAtIso), text: CITATION_EXCERPT }],
      }),
    parse: (raw) => researchAgent.parse(raw),
    store,
  });

  await runAgent({
    role: "content",
    registry,
    gateway,
    tools,
    workspaceId: ws.workspaceId,
    campaignId: ws.campaignId,
    correlationId: newId(),
    buildPrompt: () =>
      contentAgent.buildPrompt({
        brief: "Viết bài đăng ra mắt sản phẩm mới",
        brandVoice: BRAND_VOICE,
        allowedClaims: [ALLOWED_CLAIM],
        blockedClaims: ["miễn phí trọn đời"],
      }),
    parse: (raw) => contentAgent.parse(raw),
    store,
  });

  // The output-contract break (opts.breakQaOutputContract) throws HERE,
  // before anything below this call ever runs.
  const qaResult = await runAgent({
    role: "qa_brand_safety",
    registry,
    gateway,
    tools,
    workspaceId: ws.workspaceId,
    campaignId: ws.campaignId,
    correlationId: newId(),
    buildPrompt: () =>
      qaAgent.buildPrompt({
        publicationContent: PUBLICATION_CONTENT,
        claimsUsed: contentOutput.claimsUsed,
        allowedClaims: [ALLOWED_CLAIM],
        citationCount: 1,
      }),
    parse: (raw) => qaAgent.parse(raw),
    store,
  });
  const qaOutput = qaResult.output as typeof validQaOutput;

  // T8 policy gate: publishing to a real channel is always "high" risk
  // (packages/policy/src/risk.ts) and must require approval regardless of
  // what QA said -- qaVerdict is provenance only, never a permission input
  // (packages/policy/src/approval-policy.ts's own header).
  const gate = evaluateGate({
    actionKind: trustActionKind("publish_social", ["publish_social"]),
    text: PUBLICATION_CONTENT,
    qaVerdict: qaOutput.verdict,
  });
  if (gate.gate !== "approval") {
    throw new Error(
      `Golden Sequence fixture invariant violated: publishing must always require approval, got gate="${gate.gate}"`,
    );
  }

  return withTenant(pool, ws.workspaceId, async (tx) => {
    const item = createContentItem({
      workspaceId: ws.workspaceId,
      campaignId: ws.campaignId,
      kind: "social_post",
      title: "Ra mắt sản phẩm mới",
    });
    await tx.query(`insert into content_item (id, workspace_id, campaign_id, kind, title) values ($1, $2, $3, $4, $5)`, [
      item.id,
      ws.workspaceId,
      ws.campaignId,
      item.kind,
      item.title,
    ]);

    const citations: SourceCitation[] = researchOutput.findings[0]!.citations.map((c) => ({
      id: newId(),
      url: c.url,
      accessedAt: new Date(c.accessedAt),
      excerpt: c.excerpt,
      verificationStatus: "VERIFIED" as const,
    }));

    const version = addVersion(item, {
      body: contentOutput.body,
      publicationContent: contentOutput.publicationContent,
      citations,
      qualityScore: qaOutput.qualityScore,
    });
    await tx.query(
      `insert into content_version (id, workspace_id, content_item_id, version_number, body, publication_content, quality_score)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [version.id, ws.workspaceId, item.id, version.versionNumber, version.body, version.publicationContent, version.qualityScore],
    );
    for (const c of citations) {
      await tx.query(
        `insert into source_citation (id, workspace_id, content_version_id, url, accessed_at, excerpt, verification_status)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [c.id, ws.workspaceId, version.id, c.url, c.accessedAt, c.excerpt, c.verificationStatus],
      );
    }

    return {
      contentItemId: item.id,
      contentVersionId: version.id,
      citationIds: citations.map((c) => c.id),
      publicationContent: PUBLICATION_CONTENT,
      qaVerdict: qaOutput.verdict,
    };
  });
}

/**
 * Inserts a SECOND content_version under the same content_item -- a later
 * edit made after the founder already approved version 1. Used only by the
 * "publish gate" break test: `publication`'s five content-bearing columns
 * are immutable at the database itself (0011_publication_immutability.sql's
 * trigger refuses any UPDATE to publication_content/content_hash/
 * approval_decision_id/content_version_id/idempotency_key, and a CHECK ties
 * content_hash to publication_content at INSERT time too), so a publication
 * row can never actually be tampered into disagreeing with itself post
 * facto. The real way content can drift out from under an approval is this:
 * a publication gets built for a newer content_version than the one the
 * recorded ApprovalDecision actually covers.
 */
export async function insertRevisedContentVersion(
  pool: pg.Pool,
  ws: GoldenWorkspace,
  args: { contentItemId: Id; nextVersionNumber: number; body: string; publicationContent: string },
): Promise<Id> {
  const id = newId();
  await withTenant(pool, ws.workspaceId, (tx) =>
    tx.query(
      `insert into content_version (id, workspace_id, content_item_id, version_number, body, publication_content)
       values ($1, $2, $3, $4, $5, $6)`,
      [id, ws.workspaceId, args.contentItemId, args.nextVersionNumber, args.body, args.publicationContent],
    ),
  );
  return id;
}

export async function createApprovalRequest(
  pool: pg.Pool,
  ws: GoldenWorkspace,
  input: { contentVersionId: Id },
): Promise<Id> {
  const approvalRequestId = newId();
  await withTenant(pool, ws.workspaceId, (tx) =>
    tx.query(
      `insert into approval_request (id, workspace_id, campaign_id, content_version_id, target_channel)
       values ($1, $2, $3, $4, $5)`,
      [approvalRequestId, ws.workspaceId, ws.campaignId, input.contentVersionId, TARGET_CHANNEL],
    ),
  );
  return approvalRequestId;
}

/**
 * Late-review IMPORTANT 6. The founder configures the Meta channel before
 * anything can be approved for it -- `performApproval`'s T17 gate refuses an
 * approval whose target channel is not backed by a real `integration` row
 * (apps/web/src/server/channel-status.ts), and that gate was never exercised
 * by this sequence because the sequence bypassed the web layer entirely.
 *
 * `'connected'` is the honest status here and the only one available at this
 * point in the story: it claims the workspace CONFIGURED the channel, never
 * that it works. `'sandbox'` -- the "đã xác minh" claim -- cannot be written
 * yet even by a fixture, because since
 * 0033_integration_sandbox_must_be_earned.sql it requires naming a
 * publication that has actually succeeded, and no publish has happened yet.
 * That is the point: the sequence has to earn it, in order, later.
 */
export async function configureChannel(pool: pg.Pool, ws: GoldenWorkspace): Promise<void> {
  await withTenant(pool, ws.workspaceId, (tx) =>
    tx.query(`insert into integration (id, workspace_id, provider, status) values ($1, $2, $3, 'connected')`, [
      newId(),
      ws.workspaceId,
      providerForChannel(TARGET_CHANNEL),
    ]),
  );
}

export async function readIntegrationStatus(pool: pg.Pool, ws: GoldenWorkspace): Promise<string | null> {
  const r = await withTenant(pool, ws.workspaceId, (tx) =>
    tx.query(`select status from integration where workspace_id = $1 and provider = $2`, [
      ws.workspaceId,
      providerForChannel(TARGET_CHANNEL),
    ]),
  );
  const row = r.rows[0] as { status: string } | undefined;
  return row?.status ?? null;
}

export interface RecordDecisionInput {
  approvalRequestId: Id;
  contentVersionId: Id;
  citationIds: Id[];
  decision: ApprovalDecisionKind;
  reason: string;
  /** Breaks the audit-chain step: the decision itself is real and recorded,
   * but no audit_log row is written for it -- proves E12's traceToGoal walk
   * genuinely detects a missing audit event instead of papering over it. */
  skipAudit?: boolean;
}

/** The REAL human-approval gate: `decideApproval`
 * (packages/domain/src/approval.ts) refuses any actor that is not
 * `{ kind: "user" }`, refuses a blank reason, and re-runs
 * `assertRenderable` -- this is what makes the recorded ApprovalDecision a
 * real one, not a boolean the fixture invented. */
export async function recordHumanDecision(
  pool: pg.Pool,
  ws: GoldenWorkspace,
  input: RecordDecisionInput,
): Promise<Id> {
  const req: ApprovalRequest = {
    id: input.approvalRequestId,
    workspaceId: ws.workspaceId,
    campaignId: ws.campaignId,
    contentVersionId: input.contentVersionId,
    targetChannel: TARGET_CHANNEL,
    policyFlags: [],
    evidenceCitationIds: input.citationIds,
    estimatedImpact: null,
    createdAt: new Date(),
  };

  const decision = decideApproval(req, {
    actor: { kind: "user", userId: ws.userId },
    decision: input.decision,
    reason: input.reason,
  });

  await withTenant(pool, ws.workspaceId, (tx) =>
    tx.query(
      `insert into approval_decision (id, workspace_id, approval_request_id, actor_user_id, decision, reason, decided_at, content_version_id, target_channel)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [decision.id, ws.workspaceId, decision.approvalRequestId, decision.actorUserId, decision.decision, decision.reason, decision.decidedAt, decision.contentVersionId, decision.targetChannel],
    ),
  );

  if (input.skipAudit !== true) {
    const eventType =
      decision.decision === "approve"
        ? "approval.granted"
        : decision.decision === "reject"
          ? "approval.rejected"
          : "approval.changes_requested";
    await withTenant(pool, ws.workspaceId, (tx) =>
      tx.query(
        `insert into audit_log (id, workspace_id, event_type, actor_kind, actor_user_id, subject_type, subject_id, payload)
         values ($1, $2, $3, 'user', $4, 'approval_request', $5, $6::jsonb)`,
        [newId(), ws.workspaceId, eventType, ws.userId, req.id, JSON.stringify({ decision: decision.decision })],
      ),
    );
  }

  return decision.id;
}

/**
 * Late-review IMPORTANT 6: the same decision, driven through the WEB LAYER
 * the founder actually uses, not around it.
 *
 * `recordHumanDecision` above calls `decideApproval` directly, which skips
 * everything `performApproval` (apps/web/src/server/actions/approve.ts) adds
 * on top of it: the tenant cross-check, `assertRenderable`, and the T17
 * channel gate.
 *
 * Superseded, for the Golden Sequence's OWN happy path, by
 * `recordHumanDecisionViaSubmitApproval` below (hardening task 2):
 * `requireWorkspace()` is no longer the documented stub this comment used to
 * describe -- real authentication landed on `main` (0029_auth_schema.sql,
 * better-auth) after this branch was cut and is now merged in -- so the
 * sequence can and should enter one layer higher, through the real session
 * resolution AND the real `submitApproval`-equivalent FormData handling.
 * This function is kept (rather than deleted) because the BREAK 6/BREAK 7
 * tests still use it deliberately: they are about the web layer's OWN gates
 * (the channel check, the webhook signature binding), not about session
 * resolution, and injecting a trusted `{userId, workspaceId}` directly here
 * keeps those two tests focused on exactly the one thing each is proving.
 */
export async function recordHumanDecisionViaWebLayer(
  pool: pg.Pool,
  ws: GoldenWorkspace,
  input: { approvalRequestId: Id; decision: ApprovalDecisionKind; reason: string },
): Promise<Id> {
  return withTenant(pool, ws.workspaceId, async (tx) => {
    const deps: PerformApprovalDeps = {
      async loadRequest(id) {
        const r = await tx.query(
          `select id, workspace_id, campaign_id, content_version_id, target_channel, policy_flags, estimated_impact, created_at
           from approval_request where id = $1 and workspace_id = $2`,
          [id, ws.workspaceId],
        );
        const row = r.rows[0] as
          | {
              id: string;
              workspace_id: string;
              campaign_id: string;
              content_version_id: string;
              target_channel: string;
              policy_flags: ApprovalRequest["policyFlags"] | null;
              estimated_impact: string | null;
              created_at: Date;
            }
          | undefined;
        if (!row) throw new Error("Approval request not found");
        const citations = await tx.query(
          `select id from source_citation where content_version_id = $1 and workspace_id = $2`,
          [row.content_version_id, ws.workspaceId],
        );
        return {
          id: row.id as Id,
          workspaceId: row.workspace_id as Id,
          campaignId: row.campaign_id as Id,
          contentVersionId: row.content_version_id as Id,
          targetChannel: row.target_channel,
          policyFlags: row.policy_flags ?? [],
          evidenceCitationIds: (citations.rows as Array<{ id: string }>).map((c) => c.id as Id),
          estimatedImpact: row.estimated_impact,
          createdAt: row.created_at,
        };
      },
      isChannelConnected: (channel) => isChannelConnected(pool, ws.workspaceId, channel),
      async saveDecision(decision) {
        await tx.query(
          `insert into approval_decision (id, workspace_id, approval_request_id, actor_user_id, actor_kind, decision, reason, decided_at, content_version_id, target_channel)
           values ($1, $2, $3, $4, 'user', $5, $6, $7, $8, $9)`,
          [
            decision.id,
            decision.workspaceId,
            decision.approvalRequestId,
            decision.actorUserId,
            decision.decision,
            decision.reason,
            decision.decidedAt,
            decision.contentVersionId,
            decision.targetChannel,
          ],
        );
      },
      async writeAudit(event) {
        await tx.query(
          `insert into audit_log (id, workspace_id, event_type, actor_kind, actor_user_id, subject_type, subject_id, payload)
           values ($1, $2, $3, 'user', $4, 'approval_request', $5, $6::jsonb)`,
          [newId(), event.workspaceId, event.eventType, event.actorUserId, event.subjectId, JSON.stringify(event.payload)],
        );
      },
    };

    const decision = await performApproval(
      {
        approvalRequestId: input.approvalRequestId,
        decision: input.decision,
        reason: input.reason,
        session: { userId: ws.userId, workspaceId: ws.workspaceId },
      },
      deps,
    );
    return decision.id;
  });
}

/**
 * Hardening task 2: pushes the Golden Sequence's entry point up from
 * `performApproval` to the real production Server Action's own logic --
 * `submitApproval` (apps/web/src/server/actions/submit-approval.ts). Late-
 * findings-fix-report.md's concern (5) was that the sequence entered one
 * layer too low because `requireWorkspace()` was a stub when that report
 * was written; it no longer is (0029_auth_schema.sql + better-auth,
 * apps/web/src/server/auth.ts, now merged onto this branch).
 *
 * What this drives, for real, in order:
 *
 *  1. A real password sign-in through the production `auth` instance
 *     (`disableSignUp: true` -- the same instance every real request uses,
 *     never the admin/migration one) -- `ws.email`/`ws.password` must be a
 *     real, previously provisioned credential (see
 *     `apps/web/e2e/fixtures/auth-seed.ts`'s `seedWorkspaceWithLogin`).
 *  2. The real session cookie better-auth's own `signInEmail` sets,
 *     captured exactly the way a browser would carry it back
 *     (apps/web/src/server/auth.test.ts's own pattern).
 *  3. `buildSessionDeps`/`resolveWorkspace` -- the EXACT two functions
 *     `requireWorkspace()` itself calls -- resolving that real cookie to a
 *     real `{userId, workspaceId}`, including the `resolve_user_workspace`
 *     SECURITY DEFINER lookup against a real `workspace_member` row.
 *  4. A real `FormData` built the way the actual `<form
 *     action={submitApproval.bind(null, approvalRequestId)}>` in
 *     `approvals/[id]/page.tsx` builds it (`name="decision"` /
 *     `name="reason"`), parsed by the exact same `parseApprovalFormData`
 *     `submitApproval` itself calls.
 *  5. `recordApprovalDecision` -- the exact function `submitApproval` calls
 *     once it has a session, wiring the SAME `PerformApprovalDeps` from
 *     `submit-approval.ts` (not a fixture-local reimplementation) into the
 *     real `performApproval`.
 *
 * What this still does NOT reach, stated plainly (and provably: this is not
 * a gap papered over, see this repo's own reasoning for staying on a
 * vitest integration test rather than Playwright, this file's header):
 * `requireWorkspace()`'s own one-line `await headers()` call, and
 * `submitApproval`'s trailing `revalidatePath` calls. Both resolve only
 * inside a live Next.js request -- reproduced live: calling `revalidatePath`
 * from this process throws "Invariant: static generation store missing"
 * unconditionally, regardless of branch or auth state, since there is no
 * Next.js request machinery running at all in a vitest process. Everything
 * upstream and downstream of those two framework-only lines is the real
 * production code path, not a stand-in for it.
 */
export async function recordHumanDecisionViaSubmitApproval(
  ws: { email: string; password: string },
  input: { approvalRequestId: Id; decision: ApprovalDecisionKind; reason: string },
): Promise<Id> {
  const { headers: responseHeaders } = await auth.api.signInEmail({
    body: { email: ws.email, password: ws.password },
    returnHeaders: true,
  });
  const setCookie = responseHeaders.get("set-cookie");
  if (setCookie === null) throw new Error("sign-in did not set a session cookie");
  const cookieHeaders = new Headers({ cookie: setCookie.split(";")[0] as string });

  const session = await resolveWorkspace(buildSessionDeps(cookieHeaders));

  const formData = new FormData();
  formData.set("decision", input.decision);
  formData.set("reason", input.reason);

  const decision = await recordApprovalDecision(
    input.approvalRequestId,
    parseApprovalFormData(formData),
    session,
  );
  return decision.id;
}

/** The recorded decision as the database actually holds it -- including the
 * content_version_id / target_channel snapshot columns 0031 added, which are
 * what handlePublish's gate now reads (late-review CRITICAL 1). */
export async function readApprovalDecision(
  pool: pg.Pool,
  ws: GoldenWorkspace,
  approvalDecisionId: Id,
): Promise<{ decision: string; actorUserId: string; contentVersionId: string; targetChannel: string }> {
  const r = await withTenant(pool, ws.workspaceId, (tx) =>
    tx.query(
      `select decision, actor_user_id, content_version_id, target_channel
       from approval_decision where id = $1 and workspace_id = $2`,
      [approvalDecisionId, ws.workspaceId],
    ),
  );
  const row = r.rows[0] as
    | { decision: string; actor_user_id: string; content_version_id: string; target_channel: string }
    | undefined;
  if (!row) throw new Error(`Approval decision ${approvalDecisionId} not found`);
  return {
    decision: row.decision,
    actorUserId: row.actor_user_id,
    contentVersionId: row.content_version_id,
    targetChannel: row.target_channel,
  };
}

/** The persisted content the agents actually produced, and how much evidence
 * it carries -- proof steps 1-4 wrote something real (IMPORTANT 6). */
export async function readContentVersion(
  pool: pg.Pool,
  ws: GoldenWorkspace,
  contentVersionId: Id,
): Promise<{ publicationContent: string; citationCount: number }> {
  return withTenant(pool, ws.workspaceId, async (tx) => {
    const version = await tx.query(
      `select publication_content from content_version where id = $1 and workspace_id = $2`,
      [contentVersionId, ws.workspaceId],
    );
    const row = version.rows[0] as { publication_content: string } | undefined;
    if (!row) throw new Error(`Content version ${contentVersionId} not found`);
    const citations = await tx.query(
      `select count(*)::int as n from source_citation where content_version_id = $1 and workspace_id = $2`,
      [contentVersionId, ws.workspaceId],
    );
    return {
      publicationContent: row.publication_content,
      citationCount: (citations.rows[0] as { n: number }).n,
    };
  });
}

/** Late-review IMPORTANT 3 + 6: the sandbox verification the publish just
 * earned, recorded through the one function allowed to make that claim. */
export async function markChannelSandboxVerified(
  pool: pg.Pool,
  ws: GoldenWorkspace,
  publicationId: Id,
): Promise<void> {
  await recordSandboxVerification(pool, ws.workspaceId, { targetChannel: TARGET_CHANNEL, publicationId });
}

/** Builds a Publication via the REAL `buildPublication`
 * (packages/domain/src/publication.ts, which computes `contentHash` itself)
 * and inserts it `state = 'prepared'`. */
export async function insertPreparedPublication(
  pool: pg.Pool,
  ws: GoldenWorkspace,
  args: { contentVersionId: Id; publicationContent: string; approvalDecisionId: Id },
): Promise<Id> {
  const contentVersion: ContentVersion = {
    id: args.contentVersionId,
    workspaceId: ws.workspaceId,
    contentItemId: newId(), // not read by buildPublication; content_version_id is what's persisted
    versionNumber: 1,
    body: args.publicationContent,
    publicationContent: args.publicationContent,
    citations: [],
    qualityScore: null,
    createdAt: new Date(),
  };
  const publication = buildPublication({
    workspaceId: ws.workspaceId,
    campaignId: ws.campaignId,
    contentVersion,
    approvalDecisionId: args.approvalDecisionId,
    targetChannel: TARGET_CHANNEL,
  });

  await withTenant(pool, ws.workspaceId, (tx) =>
    tx.query(
      `insert into publication (id, workspace_id, campaign_id, content_version_id, approval_decision_id, publication_content, content_hash, idempotency_key, target_channel, state)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'prepared')`,
      [
        publication.id,
        ws.workspaceId,
        ws.campaignId,
        args.contentVersionId,
        args.approvalDecisionId,
        publication.publicationContent,
        publication.contentHash,
        publication.idempotencyKey,
        TARGET_CHANNEL,
      ],
    ),
  );

  return publication.id;
}

interface PublicationRow {
  id: string;
  workspace_id: string;
  campaign_id: string;
  content_version_id: string;
  approval_decision_id: string;
  publication_content: string;
  content_hash: string;
  idempotency_key: string;
  target_channel: string;
  state: string;
}

interface DecisionRow {
  id: string;
  workspace_id: string;
  approval_request_id: string;
  actor_user_id: string;
  decision: string;
  content_version_id: string;
  target_channel: string;
}

/** Real, Postgres-backed `PublishDeps` (apps/worker/src/handlers/publish.ts)
 * -- every method opens its own `withTenant` scope, exactly like every
 * other DB-backed dependency object in this repository. */
export function makePublishDeps(pool: pg.Pool, ws: GoldenWorkspace, adapter: ChannelAdapter): PublishDeps {
  return {
    async loadPublication(id): Promise<PublicationRecord | null> {
      const r = await withTenant(pool, ws.workspaceId, (tx) =>
        tx.query(
          `select id, workspace_id, campaign_id, content_version_id, approval_decision_id, publication_content, content_hash, idempotency_key, target_channel, state
           from publication where id = $1 and workspace_id = $2`,
          [id, ws.workspaceId],
        ),
      );
      const row = r.rows[0] as PublicationRow | undefined;
      if (!row) return null;
      return {
        id: row.id as Id,
        workspaceId: row.workspace_id as Id,
        campaignId: row.campaign_id as Id,
        contentVersionId: row.content_version_id as Id,
        approvalDecisionId: row.approval_decision_id as Id,
        publicationContent: row.publication_content,
        contentHash: row.content_hash,
        idempotencyKey: row.idempotency_key,
        targetChannel: row.target_channel,
        // No column on `publication` carries the resolved external account
        // id (see publish.ts's own header) -- SANDBOX_PAGE_ID stands in for
        // the integration/credential_reference resolution a production
        // loader would do.
        targetAccountId: SANDBOX_PAGE_ID,
        state: row.state as PublicationRecord["state"],
      };
    },

    async loadApprovalDecision(id): Promise<LoadedApprovalDecision | null> {
      const r = await withTenant(pool, ws.workspaceId, (tx) =>
        tx.query(
          // Late-review CRITICAL 1: read the decision's OWN content_version_id
          // and target_channel. This query used to join through
          // approval_request for content_version_id -- the mutable column the
          // reviewer's retarget attack rewrote, which made the publish gate
          // compare the tampered value against itself.
          `select ad.id, ad.workspace_id, ad.approval_request_id, ad.actor_user_id, ad.decision,
                  ad.content_version_id, ad.target_channel
           from approval_decision ad
           where ad.id = $1 and ad.workspace_id = $2`,
          [id, ws.workspaceId],
        ),
      );
      const row = r.rows[0] as DecisionRow | undefined;
      if (!row) return null;
      return {
        id: row.id as Id,
        workspaceId: row.workspace_id as Id,
        approvalRequestId: row.approval_request_id as Id,
        actorUserId: row.actor_user_id as Id,
        decision: row.decision as LoadedApprovalDecision["decision"],
        contentVersionId: row.content_version_id as Id,
        targetChannel: row.target_channel,
      };
    },

    adapter,

    async markExecuting(id): Promise<boolean> {
      const r = await withTenant(pool, ws.workspaceId, (tx) =>
        tx.query(`update publication set state = 'executing', updated_at = now() where id = $1 and state = 'prepared' returning id`, [id]),
      );
      return (r.rowCount ?? 0) > 0;
    },

    async markSucceeded(id, result): Promise<void> {
      await withTenant(pool, ws.workspaceId, (tx) =>
        tx.query(
          `update publication set state = 'succeeded', external_id = $2, permalink = $3, evidence = $4::jsonb, updated_at = now() where id = $1`,
          [id, result.externalId, result.permalink, JSON.stringify(result.evidence)],
        ),
      );
    },

    async markFailed(id, error): Promise<void> {
      await withTenant(pool, ws.workspaceId, (tx) =>
        tx.query(`update publication set state = 'failed', evidence = $2::jsonb, updated_at = now() where id = $1`, [
          id,
          JSON.stringify({ kind: error.kind, message: error.safeMessage }),
        ]),
      );
    },

    async writeAudit(event): Promise<void> {
      await withTenant(pool, ws.workspaceId, (tx) =>
        tx.query(
          `insert into audit_log (id, workspace_id, event_type, actor_kind, subject_type, subject_id, payload)
           values ($1, $2, $3, 'system', 'publication', $4, $5::jsonb)`,
          [newId(), ws.workspaceId, event.eventType, event.subjectId, JSON.stringify(event.payload)],
        ),
      );
    },
  };
}

export async function publishToSandbox(
  pool: pg.Pool,
  ws: GoldenWorkspace,
  publicationId: Id,
  adapter: ChannelAdapter,
): Promise<void> {
  await handlePublish({ publicationId, workspaceId: ws.workspaceId }, makePublishDeps(pool, ws, adapter));
}

export async function readPublicationState(
  pool: pg.Pool,
  ws: GoldenWorkspace,
  publicationId: Id,
): Promise<{ state: string; externalId: string | null }> {
  const r = await withTenant(pool, ws.workspaceId, (tx) =>
    tx.query(`select state, external_id from publication where id = $1 and workspace_id = $2`, [publicationId, ws.workspaceId]),
  );
  const row = r.rows[0] as { state: string; external_id: string | null } | undefined;
  if (!row) throw new Error(`Publication ${publicationId} not found`);
  return { state: row.state, externalId: row.external_id };
}

/** Real, Postgres-backed `IngestEventDeps`
 * (apps/worker/src/handlers/ingest-event.ts). */
export function makeIngestDeps(pool: pg.Pool, ws: GoldenWorkspace): IngestEventDeps {
  return {
    async findPublicationByExternalId(externalId) {
      const r = await withTenant(pool, ws.workspaceId, (tx) =>
        tx.query(`select id, workspace_id, campaign_id from publication where external_id = $1 and workspace_id = $2`, [
          externalId,
          ws.workspaceId,
        ]),
      );
      const row = r.rows[0] as { id: string; workspace_id: string; campaign_id: string } | undefined;
      if (!row) return null;
      return { id: row.id as Id, workspaceId: row.workspace_id as Id, campaignId: row.campaign_id as Id };
    },
    async recordDelivery(deliveryId) {
      const r = await withTenant(pool, ws.workspaceId, (tx) =>
        tx.query(
          `insert into webhook_delivery (id, workspace_id, provider, external_id, signature_ok, payload)
           values ($1, $2, 'meta', $3, true, '{}'::jsonb)
           on conflict (workspace_id, provider, external_id) where signature_ok do nothing
           returning id`,
          [newId(), ws.workspaceId, deliveryId],
        ),
      );
      return (r.rowCount ?? 0) > 0;
    },
    async insertEvent(input) {
      await withTenant(pool, ws.workspaceId, (tx) =>
        tx.query(
          `insert into event (id, workspace_id, publication_id, event_type, payload, occurred_at)
           values ($1, $2, $3, $4, $5::jsonb, $6)`,
          [newId(), ws.workspaceId, input.publicationId, input.eventType, JSON.stringify(input.payload), input.occurredAt],
        ),
      );
    },
    async upsertMetric(input) {
      await withTenant(pool, ws.workspaceId, (tx) =>
        tx.query(
          `insert into metric (id, workspace_id, campaign_id, name, value, freshness_at, attribution_model, attribution_window, confidence)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            newId(),
            ws.workspaceId,
            input.campaignId,
            input.name,
            input.value,
            input.freshnessAt,
            input.attributionModel,
            input.attributionWindow,
            input.confidence,
          ],
        ),
      );
    },
  };
}

export async function ingestSandboxEvent(pool: pg.Pool, ws: GoldenWorkspace, payload: IngestEventPayload): Promise<void> {
  await handleIngestEvent(payload, makeIngestDeps(pool, ws));
}

/**
 * Late-review IMPORTANT 6. The sequence used to call `handleIngestEvent`
 * directly, which meant it proved nothing about the layer an actual Meta
 * delivery arrives through: no signature verification, no workspace binding,
 * no body bounds, no JSON validation, no RLS-scoped route wiring. It also
 * meant the reviewer could put `return;` at the top of `handleIngestEvent`
 * and the whole sequence stayed green.
 *
 * This drives the REAL route handler (apps/web/src/app/api/webhooks/meta/
 * [workspaceId]/route.ts) with a real `Request`, a real streamed body and a
 * real `x-hub-signature-256` header -- exactly what a sandbox delivery looks
 * like on the wire. Credential vault task: the signing secret now comes
 * from `getWorkspaceWebhookSecret` (server/webhook-secret.ts), the same
 * call the route itself makes -- there is no fleet-wide root secret left to
 * derive from, so this fixture provisions/reads the SAME real, per-workspace
 * secret through the SAME vault the route resolves it from, rather than
 * recomputing it independently. Returns the HTTP status so the caller can
 * assert on it.
 */
export async function ingestSandboxEventViaWebhook(
  ws: GoldenWorkspace,
  payload: IngestEventPayload,
): Promise<number> {
  const workspaceSecret = await getWorkspaceWebhookSecret(ws.workspaceId as Id);
  if (workspaceSecret === null) {
    throw new Error(`could not provision a webhook secret for workspace ${ws.workspaceId} from the vault`);
  }
  const body = JSON.stringify({ events: [payload] });
  const signature = "sha256=" + createHmac("sha256", workspaceSecret).update(body).digest("hex");

  const { POST } = await import("../../src/app/api/webhooks/meta/[workspaceId]/route.ts");
  const response = await POST(
    new Request(`http://sandbox.test/api/webhooks/meta/${ws.workspaceId}`, {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": signature },
    }),
    { params: Promise.resolve({ workspaceId: ws.workspaceId }) },
  );
  return response.status;
}

/**
 * The same delivery, signed under a secret that is definitely NOT this
 * workspace's own -- i.e. a signature that must be refused. Used by the
 * sequence's BREAK 7 to prove the measurement step genuinely depends on the
 * workspace-bound signature rather than merely coexisting with it. Under
 * the old fleet-wide-root scheme this signed with the root secret directly
 * (the pre-CRITICAL-2 vulnerability, reproduced as a regression check);
 * there is no root secret anymore, so a fixed, obviously-wrong literal
 * proves the identical property -- "a signature not derived from THIS
 * workspace's real vault-stored secret is refused" -- without requiring one.
 */
export async function ingestSandboxEventWithForeignSignature(
  ws: GoldenWorkspace,
  payload: IngestEventPayload,
): Promise<number> {
  const foreignSecret = "definitely-not-this-workspaces-real-vault-secret";
  const body = JSON.stringify({ events: [payload] });
  const signature = "sha256=" + createHmac("sha256", foreignSecret).update(body).digest("hex");

  const { POST } = await import("../../src/app/api/webhooks/meta/[workspaceId]/route.ts");
  const response = await POST(
    new Request(`http://sandbox.test/api/webhooks/meta/${ws.workspaceId}`, {
      method: "POST",
      body,
      // A dedicated IP, not the shared "unknown" fallback: this is the one
      // call in this whole test suite that deliberately sends an invalid
      // signature through the real route, and webhook-rate-limit.ts's
      // `invalid_ip` scope is a single shared bucket for every caller that
      // omits x-forwarded-for (route.test.ts's own header carries the full
      // reasoning for why that collision is real and was reproduced live).
      headers: { "x-hub-signature-256": signature, "x-forwarded-for": `golden-sequence-break7-${newId()}` },
    }),
    { params: Promise.resolve({ workspaceId: ws.workspaceId }) },
  );
  return response.status;
}

export interface IngestedEvidence {
  events: Array<{ eventType: string; publicationId: string | null; value: unknown }>;
  metrics: Array<{ name: string; value: string; confidence: string; attributionModel: string; attributionWindow: string }>;
  deliveries: Array<{ externalId: string; signatureOk: boolean }>;
}

/**
 * Late-review IMPORTANT 6: what step 7 actually produced. The happy path
 * used to call the ingest and then assert nothing at all about `event` or
 * `metric`, so an ingest that did nothing was indistinguishable from one
 * that worked.
 */
export async function readIngestedEvidence(pool: pg.Pool, ws: GoldenWorkspace): Promise<IngestedEvidence> {
  return withTenant(pool, ws.workspaceId, async (tx) => {
    const events = await tx.query(
      `select event_type, publication_id, payload from event where workspace_id = $1 order by occurred_at`,
      [ws.workspaceId],
    );
    const metrics = await tx.query(
      `select name, value, confidence, attribution_model, attribution_window
       from metric where workspace_id = $1 order by created_at`,
      [ws.workspaceId],
    );
    const deliveries = await tx.query(
      `select external_id, signature_ok from webhook_delivery where workspace_id = $1`,
      [ws.workspaceId],
    );
    return {
      events: (events.rows as Array<{ event_type: string; publication_id: string | null; payload: { value?: unknown } }>).map(
        (r) => ({ eventType: r.event_type, publicationId: r.publication_id, value: r.payload.value }),
      ),
      metrics: (
        metrics.rows as Array<{
          name: string;
          value: string;
          confidence: string;
          attribution_model: string;
          attribution_window: string;
        }>
      ).map((r) => ({
        name: r.name,
        value: r.value,
        confidence: r.confidence,
        attributionModel: r.attribution_model,
        attributionWindow: r.attribution_window,
      })),
      deliveries: (deliveries.rows as Array<{ external_id: string; signature_ok: boolean }>).map((r) => ({
        externalId: r.external_id,
        signatureOk: r.signature_ok,
      })),
    };
  });
}

/** The four M1 agent runs the pipeline actually spent budget on -- proof
 * steps 1-4 executed rather than being skipped (IMPORTANT 6). */
export async function readAgentRunRoles(pool: pg.Pool, ws: GoldenWorkspace): Promise<string[]> {
  const r = await withTenant(pool, ws.workspaceId, (tx) =>
    tx.query(
      `select ad.role, ar.state
         from agent_run ar
         join agent_version av on av.id = ar.agent_version_id
         join agent_definition ad on ad.id = av.agent_definition_id
        where ar.workspace_id = $1 and ar.state = 'succeeded'`,
      [ws.workspaceId],
    ),
  );
  return (r.rows as Array<{ role: string }>).map((row) => row.role).sort();
}

/** Best-effort partial cleanup, matching packages/db/src/cross-tenant.test.ts's
 * own convention exactly: `approval_decision` and `audit_log` are immutable
 * (append-only, no DELETE grant to ANY role, enforced by a trigger that does
 * not check `current_user` -- 0001_core_tenancy.sql / 0007_approval.sql),
 * which transitively pins everything they reference in place too
 * (publication, content_version, content_item, campaign, goal, workspace,
 * user_account). This deletes everything that CAN be deleted; every id in
 * this fixture comes from `newId()` with a workspace-unique suffix baked
 * into every seeded name, so whatever is left behind can never collide with
 * a later run. */
export async function cleanupWorkspace(adminPool: pg.Pool, workspaceId: Id): Promise<void> {
  await adminPool.query(`delete from tool_call where workspace_id = $1`, [workspaceId]);
  await adminPool.query(`delete from run_checkpoint where workspace_id = $1`, [workspaceId]);
  await adminPool.query(`delete from agent_run where workspace_id = $1`, [workspaceId]);
  await adminPool.query(`delete from agent_version where workspace_id = $1`, [workspaceId]);
  await adminPool.query(`delete from agent_definition where workspace_id = $1`, [workspaceId]);
  await adminPool.query(`delete from event where workspace_id = $1`, [workspaceId]);
  await adminPool.query(`delete from metric where workspace_id = $1`, [workspaceId]);
  await adminPool.query(`delete from webhook_delivery where workspace_id = $1`, [workspaceId]);
  // Credential vault (0036_vault_secret.sql): ingestSandboxEventViaWebhook
  // provisions a real per-workspace webhook secret through the vault.
  await adminPool.query(`delete from vault_secret where workspace_id = $1`, [workspaceId]);
}
