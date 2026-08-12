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
      `insert into approval_decision (id, workspace_id, approval_request_id, actor_user_id, decision, reason, decided_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [decision.id, ws.workspaceId, decision.approvalRequestId, decision.actorUserId, decision.decision, decision.reason, decision.decidedAt],
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
          `select ad.id, ad.workspace_id, ad.approval_request_id, ad.actor_user_id, ad.decision, ar.content_version_id
           from approval_decision ad
           join approval_request ar on ar.id = ad.approval_request_id and ar.workspace_id = ad.workspace_id
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
           on conflict (workspace_id, provider, external_id) do nothing
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
}
