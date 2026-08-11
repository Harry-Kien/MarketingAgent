# P4 — Meta Sandbox, Telemetry and Golden Sequence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nối P1–P3 thành **Golden Sequence chạy end-to-end trên browser thật** — từ business goal tới bài đã đăng trong sandbox, có trace OpenTelemetry đầy đủ và audit truy ngược được toàn chuỗi.

**Architecture:** `packages/integrations` định nghĩa Adapter SDK; adapter Meta là **typed client trỏ vào một fake server có contract khớp Meta Graph v23**, chạy trong process test. **Không lời gọi nào ra Internet.** Publish chỉ chạy sau khi domain xác nhận có `ApprovalDecision` và hash nội dung khớp bản đã duyệt.

**Tech Stack:** TypeScript 7.0.2 · zod 4.4.3 · @opentelemetry/sdk-node 0.221.0 · pg-boss 12.27.0 · @playwright/test 1.62.1 · vitest 4.1.10

## Global Constraints

Kế thừa P0–P3, cộng thêm:

- **Meta chỉ sandbox/dry-run** (bất biến #11). Không credential thật, không network egress.
- **Không fake-success integration** (bất biến #13). Sandbox trả lỗi thật khi input sai; UI ghi rõ `Sandbox`.
- Adapter **không được gọi** nếu thiếu `ApprovalDecision` hoặc hash nội dung lệch bản đã duyệt.
- Publish thất bại ⇒ `failed`, **không auto-retry** với side effect ra ngoài.
- Mọi lời gọi adapter có `idempotency_key`.
- Egress allowlist chặn IP nội bộ và link-local (T8).

---

## File Structure Map

| Path | Trách nhiệm | Public interface |
|---|---|---|
| `packages/integrations/src/adapter.ts` | Adapter SDK | `ChannelAdapter`, `PublishInput`, `PublishResult` |
| `packages/integrations/src/errors.ts` | Error taxonomy | `AdapterError`, `ERROR_KINDS` |
| `packages/integrations/src/egress.ts` | Chặn SSRF | `assertEgressAllowed(url)` |
| `packages/integrations/src/meta/client.ts` | Typed Meta client | `createMetaAdapter(cfg)` |
| `packages/integrations/src/meta/fake-server.ts` | Sandbox Graph v23 | `startFakeMetaServer()` |
| `packages/integrations/src/credentials.ts` | Resolve tenant-scoped | `resolveCredential(...)` |
| `apps/worker/src/handlers/publish.ts` | Job handler publish | `handlePublish(deps)` |
| `apps/worker/src/handlers/ingest-event.ts` | Webhook → metric | `handleIngestEvent(deps)` |
| `apps/web/src/app/api/webhooks/meta/route.ts` | Nhận webhook có chữ ký | `POST` |
| `packages/telemetry/src/spans.ts` | Span thủ công | `withSpan(name, fn)` |
| `infra/migrations/0009_integration.sql` | `integration`, `credential_reference`, `event`, `metric` | — |
| `apps/web/e2e/golden-sequence.spec.ts` | E6 | — |

**Files KHÔNG được chạm:** `packages/domain/src/**`, `packages/agents/src/roles/**`, `apps/web/src/ui/**`.

---

### Task 1: Adapter SDK và error taxonomy

**Files:** Create `packages/integrations/package.json`, `src/adapter.ts`, `src/errors.ts` · Test `src/errors.test.ts`

**Interfaces:**
- Produces:
  - `ERROR_KINDS = ["auth_expired","rate_limited","invalid_input","quota_exceeded","upstream_unavailable","permanent_rejection"] as const`
  - `AdapterError extends Error { kind; retryable; retryAfterMs? }`
  - `PublishInput = { idempotencyKey: string; publicationContent: string; contentHash: string; targetAccountId: string }`
  - `PublishResult = { externalId: string; permalink: string; evidence: Record<string, unknown> }`
  - `ChannelAdapter = { name: string; healthCheck(): Promise<boolean>; publish(input: PublishInput): Promise<PublishResult> }`

- [ ] **Step 1: Viết failing test**

```ts
// packages/integrations/src/errors.test.ts
import { describe, expect, it } from "vitest";
import { AdapterError, ERROR_KINDS, isRetryable } from "./errors.js";

describe("error taxonomy", () => {
  it("covers the six kinds an operator must distinguish", () => {
    expect(ERROR_KINDS).toEqual(["auth_expired","rate_limited","invalid_input","quota_exceeded","upstream_unavailable","permanent_rejection"]);
  });

  it("marks transient kinds retryable and permanent kinds not", () => {
    expect(isRetryable("rate_limited")).toBe(true);
    expect(isRetryable("upstream_unavailable")).toBe(true);
    expect(isRetryable("invalid_input")).toBe(false);
    expect(isRetryable("permanent_rejection")).toBe(false);
    expect(isRetryable("auth_expired")).toBe(false);
  });

  it("carries retryAfterMs for rate limiting", () => {
    const e = new AdapterError("rate_limited", "slow down", { retryAfterMs: 5000 });
    expect(e.retryAfterMs).toBe(5000);
    expect(e.retryable).toBe(true);
  });

  it("never puts a token in the message", () => {
    const e = new AdapterError("auth_expired", "token EAAxxxxx expired");
    expect(e.safeMessage).not.toContain("EAAxxxxx");
  });
});
```

- [ ] **Step 2: Chạy test** → FAIL.

- [ ] **Step 3: Implementation**

```ts
// packages/integrations/src/errors.ts
import { redact } from "@smos/telemetry";

export const ERROR_KINDS = ["auth_expired","rate_limited","invalid_input","quota_exceeded","upstream_unavailable","permanent_rejection"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

const RETRYABLE: ReadonlySet<ErrorKind> = new Set(["rate_limited", "upstream_unavailable"]);

export function isRetryable(kind: ErrorKind): boolean { return RETRYABLE.has(kind); }

export class AdapterError extends Error {
  readonly kind: ErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  /** Safe to log or show. The raw message may embed a token. */
  readonly safeMessage: string;

  constructor(kind: ErrorKind, message: string, opts: { retryAfterMs?: number } = {}) {
    super(message);
    this.name = "AdapterError";
    this.kind = kind;
    this.retryable = isRetryable(kind);
    this.retryAfterMs = opts.retryAfterMs;
    this.safeMessage = String(redact(message)).replace(/\b(EAA|sk-|ghp_)[A-Za-z0-9_-]+/g, "[redacted]");
  }
}
```

`packages/integrations/src/adapter.ts` khai báo ba interface ở trên.

- [ ] **Step 4: Chạy test** → PASS 4 test.
- [ ] **Step 5: Commit** — `git commit -m "feat(integrations): add adapter sdk and error taxonomy"`

---

### Task 2: Egress guard — T8 SSRF

**Files:** Create `packages/integrations/src/egress.ts` · Test `src/egress.test.ts`

- [ ] **Step 1: Viết failing test**

```ts
// packages/integrations/src/egress.test.ts
import { describe, expect, it } from "vitest";
import { assertEgressAllowed } from "./egress.js";

describe("assertEgressAllowed", () => {
  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:5432/",
    "http://localhost/admin",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://[::1]/",
    "file:///etc/passwd",
  ])("refuses %s", (url) => {
    expect(() => assertEgressAllowed(url, ["graph.facebook.com"])).toThrow();
  });

  it("allows an allowlisted host over https", () => {
    expect(() => assertEgressAllowed("https://graph.facebook.com/v23.0/me", ["graph.facebook.com"])).not.toThrow();
  });

  it("refuses a host that is not on the allowlist", () => {
    expect(() => assertEgressAllowed("https://evil.test/", ["graph.facebook.com"])).toThrow(/allowlist/i);
  });

  it("refuses a lookalike subdomain", () => {
    expect(() => assertEgressAllowed("https://graph.facebook.com.evil.test/", ["graph.facebook.com"])).toThrow(/allowlist/i);
  });
});
```

- [ ] **Step 2: Chạy test** → FAIL.

- [ ] **Step 3: Implementation**

```ts
// packages/integrations/src/egress.ts
const BLOCKED_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?)/i;

/**
 * An agent can be talked into fetching a URL (threat T8). The allowlist is
 * exact-host, so graph.facebook.com.evil.test does not slip through.
 */
export function assertEgressAllowed(rawUrl: string, allowedHosts: string[]): void {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { throw new Error(`Not a valid URL: ${rawUrl}`); }

  if (url.protocol !== "https:") throw new Error(`Only https egress is permitted, got ${url.protocol}`);
  if (BLOCKED_HOST.test(url.hostname)) throw new Error(`Egress to internal address ${url.hostname} is blocked`);
  if (!allowedHosts.includes(url.hostname)) throw new Error(`Host ${url.hostname} is not on the egress allowlist`);
}
```

- [ ] **Step 4: Chạy test** → PASS 11 test.
- [ ] **Step 5: Commit** — `git commit -m "feat(integrations): block ssrf with an exact-host egress allowlist"`

---

### Task 3: Migration integration, credential, event, metric

**Files:** Create `infra/migrations/0009_integration.sql` · Test `packages/db/src/credential.test.ts`

**Interfaces:**
- Produces: bảng `integration`, `credential_reference`, `webhook_delivery`, `event`, `metric`

- [ ] **Step 1: Viết failing test — E16**

```ts
// packages/db/src/credential.test.ts
import { afterAll, describe, expect, it } from "vitest";
import { createDbPool } from "./client.js";
import { withTenant } from "./tenant-scope.js";
import { seedTwoWorkspaces } from "@smos/testing";

const pool = createDbPool(process.env["DATABASE_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5432/smos");
afterAll(async () => { await pool.end(); });

describe("E16 tenant-aware credentials", () => {
  it("stores only a vault pointer, never a secret", async () => {
    const { a } = await seedTwoWorkspaces(pool);
    const cols = await withTenant(pool, a.workspaceId, (tx) => tx.query(
      `select column_name from information_schema.columns where table_name='credential_reference'`));
    const names = cols.rows.map((c: { column_name: string }) => c.column_name);
    expect(names).toContain("vault_key");
    for (const forbidden of ["secret", "token", "password", "access_token"]) {
      expect(names, `credential_reference must not have a ${forbidden} column`).not.toContain(forbidden);
    }
  });

  it("workspace B cannot read workspace A's credential reference", async () => {
    const { a, b } = await seedTwoWorkspaces(pool);
    await withTenant(pool, a.workspaceId, (tx) => tx.query(
      `insert into integration (id,workspace_id,provider,status) values (gen_random_uuid(),$1,'meta','connected')`, [a.workspaceId]));
    await withTenant(pool, a.workspaceId, (tx) => tx.query(
      `insert into credential_reference (id,workspace_id,integration_id,vault_key)
       select gen_random_uuid(),$1,i.id,'vault://ws-a/meta' from integration i where i.workspace_id=$1 limit 1`, [a.workspaceId]));

    const seen = await withTenant(pool, b.workspaceId, (tx) => tx.query(
      `select vault_key from credential_reference where workspace_id=$1`, [a.workspaceId]));
    expect(seen.rowCount).toBe(0);
  });

  it("metric rows require freshness and attribution", async () => {
    const { a } = await seedTwoWorkspaces(pool);
    await expect(withTenant(pool, a.workspaceId, (tx) => tx.query(
      `insert into metric (id,workspace_id,campaign_id,name,value) values (gen_random_uuid(),$1,$2,'reach',100)`,
      [a.workspaceId, a.campaignId]))).rejects.toThrow(/null value|not-null/i);
  });
});
```

- [ ] **Step 2: Chạy test** → FAIL.

- [ ] **Step 3: Migration**

```sql
-- infra/migrations/0009_integration.sql
CREATE TABLE IF NOT EXISTS integration (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  provider     text NOT NULL,
  status       text NOT NULL CHECK (status IN ('not_implemented','disconnected','connected','sandbox')),
  scopes       jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_sync_at timestamptz,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider)
);
ALTER TABLE integration ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_tenant_isolation ON integration
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- Deliberately has no column that could hold a secret (threat T4).
CREATE TABLE IF NOT EXISTS credential_reference (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspace(id),
  integration_id uuid NOT NULL REFERENCES integration(id),
  vault_key      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE credential_reference ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_reference FORCE ROW LEVEL SECURITY;
CREATE POLICY credential_reference_tenant_isolation ON credential_reference
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE TABLE IF NOT EXISTS webhook_delivery (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspace(id),
  provider       text NOT NULL,
  external_id    text NOT NULL,
  signature_ok   boolean NOT NULL,
  payload        jsonb NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, external_id)
);
ALTER TABLE webhook_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_delivery_tenant_isolation ON webhook_delivery
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE TABLE IF NOT EXISTS event (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspace(id),
  publication_id uuid REFERENCES publication(id),
  event_type     text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL
);
ALTER TABLE event ENABLE ROW LEVEL SECURITY;
ALTER TABLE event FORCE ROW LEVEL SECURITY;
CREATE POLICY event_tenant_isolation ON event
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- ADR-005: a metric that cannot state its freshness and attribution must not exist.
CREATE TABLE IF NOT EXISTS metric (
  id                 uuid PRIMARY KEY,
  workspace_id       uuid NOT NULL REFERENCES workspace(id),
  campaign_id        uuid NOT NULL REFERENCES campaign(id),
  name               text NOT NULL,
  value              numeric NOT NULL,
  unit               text,
  freshness_at       timestamptz NOT NULL,
  attribution_model  text NOT NULL,
  attribution_window text NOT NULL,
  confidence         text NOT NULL CHECK (confidence IN ('low','medium','high')),
  missing_data_note  text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE metric ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_tenant_isolation ON metric
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON integration, credential_reference, webhook_delivery, event, metric TO smos_app;
```

- [ ] **Step 4: Áp và chạy test** → 3 test PASS; `npm run lint:migrations` in `migration guard ok (10 files)`. **Bằng chứng E16.**
- [ ] **Step 5: Commit** — `git commit -m "feat(db): add integration, credential reference, event and metric"`

---

### Task 4: Fake Meta server và typed adapter — E5

**Files:** Create `packages/integrations/src/meta/fake-server.ts`, `src/meta/client.ts` · Test `src/meta/contract.test.ts`

**Interfaces:**
- Produces: `startFakeMetaServer(): Promise<{ url: string; posts: Map<string,unknown>; close(): Promise<void> }>`; `createMetaAdapter(cfg: { baseUrl: string; pageId: string; token: string; allowedHosts: string[] }): ChannelAdapter`

- [ ] **Step 1: Viết failing test**

```ts
// packages/integrations/src/meta/contract.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeMetaServer } from "./fake-server.js";
import { createMetaAdapter } from "./client.js";
import { AdapterError } from "../errors.js";

let server: Awaited<ReturnType<typeof startFakeMetaServer>>;
let adapter: ReturnType<typeof createMetaAdapter>;

beforeAll(async () => {
  server = await startFakeMetaServer();
  adapter = createMetaAdapter({ baseUrl: server.url, pageId: "page-1", token: "sandbox-token", allowedHosts: ["127.0.0.1"] });
});
afterAll(async () => { await server.close(); });

const input = (key: string, content = "Bài đăng thật") => ({
  idempotencyKey: key, publicationContent: content, contentHash: "hash-" + content, targetAccountId: "page-1",
});

describe("meta adapter contract", () => {
  it("publishes and returns an external id and permalink", async () => {
    const r = await adapter.publish(input("k1"));
    expect(r.externalId).toMatch(/^page-1_/);
    expect(r.permalink).toContain(r.externalId);
    expect(r.evidence).toHaveProperty("requestId");
  });

  it("is idempotent: the same key returns the same post, not a second one", async () => {
    const a = await adapter.publish(input("k2"));
    const b = await adapter.publish(input("k2"));
    expect(b.externalId).toBe(a.externalId);
    expect([...server.posts.keys()].filter((k) => k === a.externalId)).toHaveLength(1);
  });

  it("rejects blank content with invalid_input, not a fake success", async () => {
    await expect(adapter.publish(input("k3", "   "))).rejects.toMatchObject({ kind: "invalid_input", retryable: false });
  });

  it("surfaces rate limiting as retryable with retryAfterMs", async () => {
    await expect(adapter.publish({ ...input("k4"), targetAccountId: "page-rate-limited" }))
      .rejects.toMatchObject({ kind: "rate_limited", retryable: true });
  });

  it("surfaces an expired token as auth_expired and non-retryable", async () => {
    const bad = createMetaAdapter({ baseUrl: server.url, pageId: "page-1", token: "expired", allowedHosts: ["127.0.0.1"] });
    await expect(bad.publish(input("k5"))).rejects.toMatchObject({ kind: "auth_expired", retryable: false });
  });

  it("never leaks the token in the error message", async () => {
    const bad = createMetaAdapter({ baseUrl: server.url, pageId: "page-1", token: "EAAsupersecret", allowedHosts: ["127.0.0.1"] });
    try { await bad.publish(input("k6")); } catch (e) {
      expect((e as AdapterError).safeMessage).not.toContain("EAAsupersecret");
    }
  });

  it("health check reports true for a reachable sandbox", async () => {
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });
});
```

- [ ] **Step 2: Chạy test** → FAIL.

- [ ] **Step 3: Implementation** — `fake-server.ts` dùng `node:http`, phản hồi theo hình dạng Graph v23 (`{ id: "<pageId>_<n>" }` khi thành công, `{ error: { code, message, type } }` khi lỗi), có nhánh `page-rate-limited` trả 429 kèm `retry-after`, nhánh token `expired` trả 190. `client.ts` gọi `assertEgressAllowed`, map mã lỗi Graph sang `ErrorKind`, gửi `idempotencyKey` và lưu để trả lại kết quả cũ.

- [ ] **Step 4: Chạy test** → PASS 7 test. **Bằng chứng E5.**
- [ ] **Step 5: Commit** — `git commit -m "feat(integrations): add sandbox meta adapter with contract tests"`

---

### Task 5: Publish handler — cổng approval cuối cùng trước khi ra ngoài

**Files:** Create `apps/worker/src/handlers/publish.ts` · Test `apps/worker/src/handlers/publish.test.ts`

**Interfaces:**
- Produces: `handlePublish(job: { publicationId: Id; workspaceId: Id }, deps: PublishDeps): Promise<void>` với `PublishDeps = { loadPublication; loadApprovalDecision; adapter; markExecuting; markSucceeded; markFailed; writeAudit }`

- [ ] **Step 1: Viết failing test**

```ts
// apps/worker/src/handlers/publish.test.ts
import { describe, expect, it, vi } from "vitest";
import { handlePublish } from "./publish.js";
import { hashPublicationContent, newId } from "@smos/domain";
import { AdapterError } from "@smos/integrations";

const content = "Bài đăng đã duyệt";
const pub = (over = {}) => ({
  id: newId(), workspaceId: newId(), campaignId: newId(), contentVersionId: newId(),
  approvalDecisionId: newId(), publicationContent: content, contentHash: hashPublicationContent(content),
  idempotencyKey: "k1", targetChannel: "meta_page", targetAccountId: "page-1", state: "prepared", ...over,
});

const deps = (over = {}) => ({
  loadPublication: async () => pub(),
  loadApprovalDecision: async () => ({ id: newId(), decision: "approve" as const }),
  adapter: { name: "meta", healthCheck: async () => true, publish: vi.fn(async () => ({ externalId: "page-1_9", permalink: "https://x/9", evidence: {} })) },
  markExecuting: vi.fn(async () => undefined),
  markSucceeded: vi.fn(async () => undefined),
  markFailed: vi.fn(async () => undefined),
  writeAudit: vi.fn(async () => undefined),
  ...over,
});

const job = { publicationId: newId(), workspaceId: newId() };

describe("handlePublish", () => {
  it("publishes when the approval decision exists and the hash matches", async () => {
    const d = deps();
    await handlePublish(job, d);
    expect(d.adapter.publish).toHaveBeenCalledOnce();
    expect(d.markSucceeded).toHaveBeenCalledOnce();
    expect(d.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "publication.succeeded" }));
  });

  it("refuses when there is no approval decision, and never calls the adapter", async () => {
    const d = deps({ loadApprovalDecision: async () => null });
    await expect(handlePublish(job, d)).rejects.toThrow(/approval/i);
    expect(d.adapter.publish).not.toHaveBeenCalled();
  });

  it("refuses when the decision was a rejection", async () => {
    const d = deps({ loadApprovalDecision: async () => ({ id: newId(), decision: "reject" as const }) });
    await expect(handlePublish(job, d)).rejects.toThrow(/approved/i);
    expect(d.adapter.publish).not.toHaveBeenCalled();
  });

  it("refuses when the content drifted after approval", async () => {
    const d = deps({ loadPublication: async () => pub({ contentHash: "hash-of-something-else" }) });
    await expect(handlePublish(job, d)).rejects.toThrow(/drift|hash/i);
    expect(d.adapter.publish).not.toHaveBeenCalled();
  });

  it("does not auto-retry a permanent failure", async () => {
    const d = deps({ adapter: { name: "meta", healthCheck: async () => true, publish: vi.fn(async () => { throw new AdapterError("invalid_input", "bad"); }) } });
    await expect(handlePublish(job, d)).rejects.toThrow();
    expect(d.adapter.publish).toHaveBeenCalledOnce();
    expect(d.markFailed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ retryable: false }));
  });

  it("refuses to publish twice for the same publication", async () => {
    const d = deps({ loadPublication: async () => pub({ state: "succeeded" }) });
    await handlePublish(job, d);
    expect(d.adapter.publish).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Chạy test** → FAIL.

- [ ] **Step 3: Implementation**

```ts
// apps/worker/src/handlers/publish.ts
import { hashPublicationContent, type Id } from "@smos/domain";
import { AdapterError, type ChannelAdapter } from "@smos/integrations";
import { logger } from "@smos/telemetry";

export interface PublishDeps {
  loadPublication(id: Id): Promise<{ id: Id; workspaceId: Id; approvalDecisionId: Id | null; publicationContent: string; contentHash: string; idempotencyKey: string; targetAccountId: string; state: string } | null>;
  loadApprovalDecision(id: Id): Promise<{ id: Id; decision: "approve" | "reject" | "request_changes" } | null>;
  adapter: ChannelAdapter;
  markExecuting(id: Id): Promise<void>;
  markSucceeded(id: Id, r: { externalId: string; permalink: string; evidence: Record<string, unknown> }): Promise<void>;
  markFailed(id: Id, e: { kind: string; retryable: boolean; safeMessage: string }): Promise<void>;
  writeAudit(e: { eventType: string; subjectId: Id; payload: Record<string, unknown> }): Promise<void>;
}

/**
 * The last gate before anything leaves the system. Every check here is a
 * refusal to call the adapter, not a warning (threats T1, T2).
 */
export async function handlePublish(job: { publicationId: Id; workspaceId: Id }, deps: PublishDeps): Promise<void> {
  const pub = await deps.loadPublication(job.publicationId);
  if (pub === null) throw new Error(`Publication ${job.publicationId} not found`);
  if (pub.state === "succeeded") {
    logger.info("publication already succeeded; skipping", { publicationId: pub.id });
    return;
  }
  if (pub.approvalDecisionId === null) throw new Error("Publication has no approval decision; refusing to publish");

  const decision = await deps.loadApprovalDecision(pub.approvalDecisionId);
  if (decision === null) throw new Error("Approval decision not found; refusing to publish");
  if (decision.decision !== "approve") throw new Error(`Approval decision is "${decision.decision}", not approved; refusing to publish`);

  // Content could have been edited between approval and execution.
  if (hashPublicationContent(pub.publicationContent) !== pub.contentHash) {
    throw new Error("Content drift detected: the text no longer matches what was approved");
  }

  await deps.markExecuting(pub.id);
  try {
    const result = await deps.adapter.publish({
      idempotencyKey: pub.idempotencyKey, publicationContent: pub.publicationContent,
      contentHash: pub.contentHash, targetAccountId: pub.targetAccountId,
    });
    await deps.markSucceeded(pub.id, result);
    await deps.writeAudit({ eventType: "publication.succeeded", subjectId: pub.id, payload: { externalId: result.externalId, permalink: result.permalink } });
  } catch (error) {
    const e = error instanceof AdapterError ? error : new AdapterError("upstream_unavailable", String(error));
    // No automatic retry with an external side effect: a duplicate post is
    // worse than a delayed one (lesson carried from the legacy system).
    await deps.markFailed(pub.id, { kind: e.kind, retryable: e.retryable, safeMessage: e.safeMessage });
    await deps.writeAudit({ eventType: "publication.failed", subjectId: pub.id, payload: { kind: e.kind, message: e.safeMessage } });
    throw e;
  }
}
```

- [ ] **Step 4: Chạy test** → PASS 6 test.
- [ ] **Step 5: Commit** — `git commit -m "feat(worker): gate publishing on approval and content hash"`

---

### Task 6: Span thủ công cho agent run và adapter

**Files:** Create `packages/telemetry/src/spans.ts` · Test `packages/telemetry/src/spans.test.ts`

**Interfaces:**
- Produces: `withSpan<T>(name: string, attrs: Record<string,string|number|boolean>, fn: () => Promise<T>): Promise<T>`

- [ ] **Step 1: Viết failing test**

```ts
// packages/telemetry/src/spans.test.ts
import { describe, expect, it } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor, BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";
import { withSpan } from "./spans.js";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
trace.setGlobalTracerProvider(provider);

describe("withSpan", () => {
  it("records a span with its attributes", async () => {
    exporter.reset();
    await withSpan("agent.run", { "agent.role": "content", "workspace.id": "ws-1" }, async () => "ok");
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("agent.run");
    expect(span?.attributes["agent.role"]).toBe("content");
  });

  it("marks the span as error and rethrows", async () => {
    exporter.reset();
    await expect(withSpan("adapter.publish", {}, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(2);
  });

  it("does not put secrets into attributes", async () => {
    exporter.reset();
    await withSpan("adapter.publish", { token: "EAAsecret" } as never, async () => "ok");
    const [span] = exporter.getFinishedSpans();
    expect(JSON.stringify(span?.attributes)).not.toContain("EAAsecret");
  });
});
```

- [ ] **Step 2: Chạy test** → FAIL. Cài `@opentelemetry/api@1.9.0`, `@opentelemetry/sdk-trace-base@2.4.0`.

- [ ] **Step 3: Implementation** — `withSpan` dùng `trace.getTracer("smos")`, chạy attrs qua `redact` trước khi set, `setStatus({ code: SpanStatusCode.ERROR })` khi ném lỗi, luôn `span.end()` trong `finally`.

- [ ] **Step 4: Chạy test** → PASS 3 test.
- [ ] **Step 5: Bọc span vào `runAgent` và `handlePublish`** rồi chạy lại test của P2 và Task 5 để chắc không vỡ.
- [ ] **Step 6: Commit** — `git commit -m "feat(telemetry): add manual spans for agent runs and adapter calls"`

---

### Task 7: Webhook có chữ ký và event ingestion

**Files:** Create `apps/web/src/app/api/webhooks/meta/route.ts`, `apps/worker/src/handlers/ingest-event.ts` · Test `apps/worker/src/handlers/ingest-event.test.ts`, `apps/web/src/server/webhook-signature.test.ts`

**Interfaces:**
- Produces: `verifySignature(body: string, header: string, secret: string): boolean`; `handleIngestEvent(payload, deps)`

- [ ] **Step 1: Viết failing test**

```ts
// apps/web/src/server/webhook-signature.test.ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySignature } from "./webhook-signature.js";

const secret = "sandbox-secret";
const body = JSON.stringify({ object: "page", entry: [] });
const sign = (b: string) => "sha256=" + createHmac("sha256", secret).update(b).digest("hex");

describe("verifySignature", () => {
  it("accepts a correct signature", () => { expect(verifySignature(body, sign(body), secret)).toBe(true); });
  it("rejects a tampered body", () => { expect(verifySignature(body + "x", sign(body), secret)).toBe(false); });
  it("rejects a missing header", () => { expect(verifySignature(body, "", secret)).toBe(false); });
  it("rejects a wrong algorithm prefix", () => {
    expect(verifySignature(body, "sha1=" + createHmac("sha1", secret).update(body).digest("hex"), secret)).toBe(false);
  });
  it("uses a constant-time comparison", () => {
    // Length mismatch must not throw; it must simply return false.
    expect(() => verifySignature(body, "sha256=aa", secret)).not.toThrow();
    expect(verifySignature(body, "sha256=aa", secret)).toBe(false);
  });
});
```

```ts
// apps/worker/src/handlers/ingest-event.test.ts
import { describe, expect, it, vi } from "vitest";
import { handleIngestEvent } from "./ingest-event.js";
import { newId } from "@smos/domain";

const deps = (over = {}) => ({
  findPublicationByExternalId: async () => ({ id: newId(), workspaceId: newId(), campaignId: newId() }),
  recordDelivery: vi.fn(async () => true),
  insertEvent: vi.fn(async () => undefined),
  upsertMetric: vi.fn(async () => undefined),
  ...over,
});

describe("handleIngestEvent", () => {
  it("stores the event and updates a metric with freshness", async () => {
    const d = deps();
    await handleIngestEvent({ externalId: "page-1_9", eventType: "post.impression", value: 120, occurredAt: new Date().toISOString(), deliveryId: "d1" }, d);
    expect(d.insertEvent).toHaveBeenCalledOnce();
    expect(d.upsertMetric).toHaveBeenCalledWith(expect.objectContaining({
      freshnessAt: expect.any(Date), attributionModel: expect.any(String), confidence: expect.any(String),
    }));
  });

  it("is idempotent on repeated delivery ids", async () => {
    const d = deps({ recordDelivery: vi.fn(async () => false) });
    await handleIngestEvent({ externalId: "page-1_9", eventType: "post.impression", value: 1, occurredAt: new Date().toISOString(), deliveryId: "d1" }, d);
    expect(d.insertEvent).not.toHaveBeenCalled();
  });

  it("ignores an event for an unknown publication rather than guessing", async () => {
    const d = deps({ findPublicationByExternalId: async () => null });
    await handleIngestEvent({ externalId: "unknown", eventType: "post.impression", value: 1, occurredAt: new Date().toISOString(), deliveryId: "d2" }, d);
    expect(d.insertEvent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Chạy test** → FAIL cả hai.

- [ ] **Step 3: Implementation** — `verifySignature` dùng `timingSafeEqual` sau khi kiểm độ dài; route trả **401** khi chữ ký sai và **không** ghi gì ngoài `webhook_delivery.signature_ok = false`; `handleIngestEvent` dùng `UNIQUE (workspace_id, provider, external_id)` để idempotent, và mọi `metric` ghi ra đều kèm `freshness_at`, `attribution_model`, `attribution_window`, `confidence`.

- [ ] **Step 4: Chạy test** → PASS 8 test.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): verify webhook signatures and ingest events idempotently"`

---

### Task 8: Golden Sequence E2E — E6, E7, E12

**Files:** Create `apps/web/e2e/golden-sequence.spec.ts`, `apps/web/e2e/fixtures/seed.ts`

- [ ] **Step 1: Viết failing test**

```ts
// apps/web/e2e/golden-sequence.spec.ts
import { expect, test } from "@playwright/test";
import { runGoldenSequenceBackend, traceChainFor } from "./fixtures/seed.js";

test.describe("Golden Sequence", () => {
  test("goal to published post to measured result, traceable end to end", async ({ page }) => {
    // 1-6: orchestrator -> research -> content -> QA, all with the fake provider.
    const { campaignId, approvalRequestId, publicationId } = await runGoldenSequenceBackend();

    // 7: Approval Center shows diff, evidence, policy flags and target channel.
    await page.goto(`/approvals/${approvalRequestId}`);
    await expect(page.getByRole("heading", { name: "Đang chờ bạn phê duyệt" })).toBeVisible();
    await expect(page.getByTestId("evidence-list").getByRole("listitem")).not.toHaveCount(0);
    await expect(page.getByTestId("target-channel")).toContainText("meta_page");
    await expect(page.getByTestId("chain-of-thought")).toHaveCount(0);

    // 8: the founder approves.
    await page.getByRole("button", { name: "Phê duyệt" }).click();
    await expect(page.getByRole("status")).toContainText("Đã duyệt");

    // 9-11: sandbox publish, event returns, analytics updates.
    await page.goto(`/campaigns/${campaignId}`);
    await expect(page.getByTestId("publication-permalink")).toBeVisible({ timeout: 30_000 });
    await page.goto("/analytics");
    await expect(page.getByTestId("metric-reach")).toBeVisible();
    await expect(page.getByTestId("metric-reach")).toContainText("Cập nhật lúc");

    // 13: audit walks the whole chain back to the goal.
    const chain = await traceChainFor(publicationId);
    expect(chain.goalId).toBeTruthy();
    expect(chain.approvalDecisionId).toBeTruthy();
    expect(chain.auditEvents.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(["approval.granted", "publication.succeeded"]),
    );
  });

  test("12: the optimisation suggestion is never applied automatically", async ({ page }) => {
    await page.goto("/analytics");
    const suggestions = page.getByTestId("optimisation-suggestion");
    if (await suggestions.count() > 0) {
      await expect(suggestions.first().getByRole("button", { name: /Áp dụng/ })).toHaveCount(0);
    }
  });

  test("desktop and mobile screenshots for visual review", async ({ page }) => {
    for (const [name, size] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]] as const) {
      await page.setViewportSize(size);
      for (const path of ["/", "/approvals", "/analytics"]) {
        await page.goto(path);
        await page.screenshot({ path: `docs/research/assets/e2e-${name}-${path.replace(/\W+/g, "_")}.png`, fullPage: true });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        expect(overflow, `${path} at ${name} must not scroll horizontally`).toBe(false);
      }
    }
  });
});
```

- [ ] **Step 2: Chạy test** → FAIL, chưa có fixture.

- [ ] **Step 3: Implementation** — `fixtures/seed.ts` chạy backend thật: tạo workspace + user + goal, chạy `runAgent` bốn lần với `createFakeProvider`, tạo `ApprovalRequest`, và đăng ký fake Meta server làm adapter. `traceChainFor` gọi `traceToGoal` từ P1.

- [ ] **Step 4: Chạy test** → PASS 3 test. **Bằng chứng E6.**

- [ ] **Step 5: Visual QA thật**

Mở từng ảnh trong `docs/research/assets/e2e-*.png` và **đánh giá bằng mắt**: thứ bậc thông tin · tràn ngang · contrast · va chạm dấu tiếng Việt · State Ribbon đọc được · bảng ở 390px. Sửa lỗi rồi chạy lại. **Bằng chứng E7.**

- [ ] **Step 6: Commit** — `git commit -m "test(e2e): prove the golden sequence end to end on a real browser"`

---

### Task 9: Integration status trung thực và cổng verify cuối

**Files:** Create `apps/web/src/app/(app)/integrations/page.tsx` · Test `apps/web/src/app/(app)/integrations/status.test.ts`

**Interfaces:**
- Produces: `describeIntegration(row): { label: string; canConnect: boolean; badge: "Sandbox"|"Chưa triển khai"|"Đã kết nối"|"Mất kết nối" }`

- [ ] **Step 1: Viết failing test**

```ts
// apps/web/src/app/(app)/integrations/status.test.ts
import { describe, expect, it } from "vitest";
import { describeIntegration } from "./status.js";

describe("describeIntegration", () => {
  it("labels a sandbox integration as sandbox, never as connected", () => {
    const d = describeIntegration({ provider: "meta", status: "sandbox" });
    expect(d.badge).toBe("Sandbox");
    expect(d.canConnect).toBe(false);
  });

  it("labels an unimplemented provider honestly and offers no connect button", () => {
    const d = describeIntegration({ provider: "tiktok", status: "not_implemented" });
    expect(d.badge).toBe("Chưa triển khai");
    expect(d.canConnect).toBe(false);
  });

  it("never returns a connect affordance for a provider with no adapter", () => {
    for (const provider of ["tiktok", "linkedin", "zalo", "youtube"]) {
      expect(describeIntegration({ provider, status: "not_implemented" }).canConnect).toBe(false);
    }
  });

  it("allows connecting only a real implemented provider", () => {
    expect(describeIntegration({ provider: "meta", status: "disconnected" }).canConnect).toBe(true);
  });
});
```

- [ ] **Step 2: Chạy test** → FAIL.
- [ ] **Step 3: Implementation** — trang Integrations liệt kê provider kèm badge trung thực; provider chưa có adapter hiển thị `Chưa triển khai` và **không** có nút Connect (bất biến #13).
- [ ] **Step 4: Chạy test** → PASS 4 test.

- [ ] **Step 5: Cổng verify cuối cùng của M0+M1**

Run:
```bash
npm run verify
npx playwright test --config apps/web/playwright.config.ts
```
Expected: mọi guard `ok` · typecheck 0 lỗi · toàn bộ unit/integration test pass · toàn bộ E2E pass.

Rồi kiểm tra thủ công rằng **không có lời gọi ra Internet**:
```bash
grep -rn "graph.facebook.com" packages/ apps/ --include=*.ts | grep -v test | grep -v fake-server
```
Expected: không có dòng nào ngoài cấu hình mặc định chưa dùng.

- [ ] **Step 6: Commit** — `git commit -m "feat(web): report integration status honestly and close m1 verification"`

---

## Acceptance Criteria

| # | Tiêu chí | Bằng chứng |
|---|---|---|
| E-1 | Adapter contract test với sandbox có hành vi lỗi thật | E5 — Task 4 |
| E-2 | Golden Sequence E2E xanh trên browser thật | E6 — Task 8 |
| E-3 | Screenshot desktop + mobile, đã visual critique và sửa | E7 — Task 8 Step 5 |
| E-4 | Credential tenant-scoped, không cột chứa secret | E16 — Task 3 |
| E-5 | Audit truy ngược publication → goal, có `approval.granted` và `publication.succeeded` | E12 — Task 8 |
| E-6 | Publish bị chặn khi thiếu approval hoặc hash lệch | Task 5 |
| E-7 | Không auto-retry side effect ra ngoài | Task 5 |
| E-8 | Webhook sai chữ ký ⇒ 401, ingestion idempotent | Task 7 |
| E-9 | SSRF bị chặn kể cả lookalike domain | Task 2 |
| E-10 | Integration chưa làm hiển thị `Chưa triển khai`, không nút giả | Task 9 |
| E-11 | Trace OTel có span cho agent run và adapter call | Task 6 |

## Security Checks

- **T1/T2**: `handlePublish` từ chối khi thiếu decision, khi decision không phải `approve`, và khi hash nội dung lệch. Ba refusal độc lập, mỗi cái có test.
- **T7 webhook giả**: HMAC SHA-256 constant-time; `UNIQUE (workspace_id, provider, external_id)` chống replay.
- **T8 SSRF**: allowlist exact-host, chặn dải nội bộ và link-local, chỉ https.
- **T4**: `credential_reference` không có cột nào chứa được secret; `AdapterError.safeMessage` đã redact; span attribute đã redact.
- **T16 nhầm tài khoản đích**: `targetAccountId` được xác thực lại tại thời điểm execute và hiển thị trên Approval Center.

## Tenancy Checks

D1-5 ✅ hoàn tất — E16 chứng minh workspace B không resolve được credential của A, và log lần thất bại không chứa secret.

## Audit Evidence

`publication.succeeded` / `publication.failed` ghi `external_id`, `permalink`, `kind`, `safeMessage`. `webhook_delivery` ghi cả lần chữ ký sai. Task 8 chứng minh chuỗi audit đầy đủ từ `approval.granted` tới `publication.succeeded`.

## Observability Evidence

Span `agent.run` và `adapter.publish` có attribute đã redact, status ERROR khi ném lỗi. Cộng auto-instrumentation HTTP và `pg` từ P0.

## Rollback / Recovery

- Publish thất bại để lại `publication.state = 'failed'` với `kind` và `safeMessage`; thử lại là **hành động thủ công của Founder**, không phải job tự động.
- `idempotency_key` UNIQUE nghĩa là thử lại cùng nội dung không tạo bài trùng.
- Sandbox không có state bền — restart là sạch.

## Non-Goals

Meta Graph **thật** (M2) · OAuth lifecycle thật (M2) · quota tracking thật (M2) · các kênh khác · PostHog/GA4/GSC (M5) · per-day budget và kill switch UI · dead-letter UI · down-migration (M2).

## Manual Verification

1. `docker compose up -d db && npm run verify`
2. `npx playwright test --config apps/web/playwright.config.ts --headed` — xem luồng chạy thật.
3. Mở `/integrations` — xác nhận TikTok, LinkedIn, Zalo, YouTube hiển thị `Chưa triển khai` và **không** có nút Connect.
4. Mở `/approvals/<id>` của campaign đã duyệt — xác nhận không có nút approve lần hai.
5. Xem `docs/research/assets/e2e-*.png` bằng mắt.

## Browser Verification

Playwright chromium 1440×900 và 390×844, luồng Golden Sequence đầy đủ, cộng kiểm tra không tràn ngang trên cả hai kích thước.

## Evidence Tiers

| Tier | P4 |
|---|---|
| **Source check** | ✅ Toàn bộ guard; grep xác nhận không gọi host thật |
| **Local runtime** | ✅ Publish gate, webhook, egress, span |
| **Sandbox integration** | ✅ **E5, E6, E7 đầy đủ** — adapter sandbox, E2E browser thật, screenshot đã phê bình |
| **Production verification** | ❌ **Chưa có và sẽ không có ở M0/M1.** Chưa từng đăng lên tài khoản thật, chưa từng dùng credential thật |

---

## Tuyên bố được phép sau khi P4 xanh

> "Campaign Execution Spine chạy end-to-end trên sandbox có bằng chứng."

**Không** dùng: `production-ready`, `hoàn thành`, `ổn định`, `an toàn`.
