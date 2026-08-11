# P1 — Workspace, Tenancy and Core Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dựng domain model, tenant isolation ba lớp, audit append-only và state machine — chứng minh bằng test rằng **cross-workspace bị chặn** và **approval không thể giả mạo**, kể cả khi code ứng dụng sai.

**Architecture:** `packages/domain` là TypeScript thuần, không import Drizzle, không import framework (ADR-002 M2). `packages/db` chứa schema Drizzle và repository implementation. Tenant isolation phòng thủ ba lớp (ADR-007): tenant context ở ứng dụng, **RLS ở PostgreSQL**, và constraint ở schema. Bất biến approval được cưỡng chế bằng **CHECK constraint và foreign key ở database**, không phải bằng code — vì code sẽ sai ở đâu đó trong vòng đời dự án.

**Tech Stack:** TypeScript 7.0.2 · drizzle-orm 0.45.2 · drizzle-kit 0.31.10 · PostgreSQL 17 RLS · zod 4.4.3 · vitest 4.1.10 · pg-boss 12.27.0

## Global Constraints

Kế thừa toàn bộ Global Constraints của P0, cộng thêm:

- **`packages/domain` KHÔNG được import `drizzle-orm`, `pg`, `next`, hay `react`.** Cưỡng chế bằng Task 13.
- **Mọi bảng thuộc workspace phải có `workspace_id uuid NOT NULL REFERENCES workspace(id)`.** Cưỡng chế bằng migration lint (Task 1).
- **Mọi bảng thuộc workspace phải bật RLS.** Cưỡng chế bằng cùng lint đó.
- Ứng dụng kết nối bằng DB role **không có `BYPASSRLS`**. Migration chạy bằng role khác.
- **Không hard-code `workspace_id`** ở bất kỳ đâu.
- **Không** enum, cột hay bảng "để dành" cho Journey (bất biến #8).
- **Không dùng `quality_score` để cấp execution permission** (bất biến #4). `quality_score` chỉ là dữ liệu hiển thị và dữ liệu để QA quyết định veto.
- ID dùng **UUID v7** sinh ở tầng ứng dụng để có thứ tự theo thời gian.
- Migration là **SQL thuần** trong `infra/migrations/`, đánh số tăng dần.

---

## File Structure Map

| Path | Trách nhiệm | Phụ thuộc | Public interface |
|---|---|---|---|
| `packages/domain/src/ids.ts` | Sinh và kiểm ID | — | `newId()`, `isId()`, `type Id` |
| `packages/domain/src/tenant.ts` | Tenant context | `ids` | `TenantContext`, `requireTenant()` |
| `packages/domain/src/actor.ts` | Phân loại principal | `ids` | `Actor`, `isUserActor()`, `isAgentActor()` |
| `packages/domain/src/lifecycle.ts` | State machine | — | `LifecycleState`, `canTransition()`, `applyTransition()` |
| `packages/domain/src/campaign.ts` | Campaign aggregate | lifecycle, ids | `Campaign`, `createCampaign()`, `transitionCampaign()` |
| `packages/domain/src/content.ts` | Content + citation | ids | `ContentItem`, `ContentVersion`, `SourceCitation` |
| `packages/domain/src/approval.ts` | Approval rule | actor, ids | `ApprovalRequest`, `decideApproval()` |
| `packages/domain/src/publication.ts` | Publication contract | ids | `Publication`, `buildPublication()` |
| `packages/domain/src/ports.ts` | Repository interface | tất cả trên | `CampaignRepo`, `AuditRepo`, `OutboxRepo`, … |
| `packages/domain/src/errors.ts` | Lỗi domain | — | `DomainError`, `TenantViolationError`, … |
| `packages/db/src/schema/*.ts` | Bảng Drizzle | `drizzle-orm` | table objects |
| `packages/db/src/tenant-scope.ts` | Đặt RLS session var | `drizzle-orm` | `withTenant()` |
| `packages/db/src/repositories/*.ts` | Implementation | domain ports | repo factories |
| `infra/migrations/0001_*.sql` … | DDL, RLS, trigger | — | — |
| `scripts/check-migrations.mjs` | Lint tenancy trên DDL | — | exit code |
| `scripts/check-domain-purity.mjs` | Chặn import rò rỉ | — | exit code |

**Files KHÔNG được chạm:** `docs/**`, `apps/web/src/app/page.tsx` (P3 sở hữu), `packages/telemetry/**`, `packages/queue/**` (P0 sở hữu, đã ổn định).

---

### Task 1: Migration lint — chặn bảng thiếu tenancy trước khi có bảng nào

Task này đi **trước** mọi migration có chủ đích: guard phải tồn tại trước thứ nó bảo vệ.

**Files:**
- Create: `scripts/migration-guards.mjs`, `scripts/check-migrations.mjs`
- Modify: `package.json` (thêm `lint:migrations` vào `verify`)
- Test: `scripts/migration-guards.test.mjs`

**Interfaces:**
- Produces: `findTenancyViolations(sql: string): string[]`, `findRlsViolations(sql: string): string[]`

- [ ] **Step 1: Viết failing test**

`scripts/migration-guards.test.mjs`:
```js
import { describe, expect, it } from "vitest";
import { findTenancyViolations, findRlsViolations, GLOBAL_TABLES } from "./migration-guards.mjs";

describe("findTenancyViolations", () => {
  it("flags a workspace-owned table without workspace_id", () => {
    const sql = `CREATE TABLE campaign (id uuid PRIMARY KEY, name text NOT NULL);`;
    expect(findTenancyViolations(sql)).toEqual(["campaign"]);
  });

  it("accepts a table that has workspace_id", () => {
    const sql = `CREATE TABLE campaign (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspace(id), name text NOT NULL);`;
    expect(findTenancyViolations(sql)).toEqual([]);
  });

  it("exempts declared global tables", () => {
    const sql = `CREATE TABLE workspace (id uuid PRIMARY KEY, name text NOT NULL);`;
    expect(GLOBAL_TABLES).toContain("workspace");
    expect(findTenancyViolations(sql)).toEqual([]);
  });
});

describe("findRlsViolations", () => {
  it("flags a workspace-owned table with no ENABLE ROW LEVEL SECURITY", () => {
    const sql = `CREATE TABLE campaign (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);`;
    expect(findRlsViolations(sql)).toEqual(["campaign"]);
  });

  it("accepts a table that enables RLS", () => {
    const sql = `
      CREATE TABLE campaign (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
      ALTER TABLE campaign ENABLE ROW LEVEL SECURITY;`;
    expect(findRlsViolations(sql)).toEqual([]);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run scripts/migration-guards.test.mjs`
Expected: FAIL — không resolve được `./migration-guards.mjs`.

- [ ] **Step 3: Viết implementation tối thiểu**

`scripts/migration-guards.mjs`:
```js
/**
 * Tables that legitimately have no workspace_id. Adding to this list is a
 * reviewed decision (ADR-007), never a convenience.
 */
export const GLOBAL_TABLES = ["workspace", "user_account", "session", "account", "verification", "__drizzle_migrations"];

const CREATE_TABLE = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"?(\w+)"?\s*\(([\s\S]*?)\n\);/gi;

function tables(sql) {
  const out = [];
  for (const m of sql.matchAll(CREATE_TABLE)) out.push({ name: m[1], body: m[2] });
  return out.filter((t) => !GLOBAL_TABLES.includes(t.name));
}

export function findTenancyViolations(sql) {
  return tables(sql).filter((t) => !/\bworkspace_id\b/.test(t.body)).map((t) => t.name);
}

export function findRlsViolations(sql) {
  return tables(sql)
    .filter((t) => !new RegExp(`ALTER TABLE\\s+"?${t.name}"?\\s+ENABLE ROW LEVEL SECURITY`, "i").test(sql))
    .map((t) => t.name);
}
```

`scripts/check-migrations.mjs`:
```js
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findTenancyViolations, findRlsViolations } from "./migration-guards.mjs";

const dir = "infra/migrations";
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const all = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");

let failed = false;
for (const name of findTenancyViolations(all)) { console.error(`migration: table "${name}" is workspace-owned but has no workspace_id (D1-1)`); failed = true; }
for (const name of findRlsViolations(all)) { console.error(`migration: table "${name}" does not ENABLE ROW LEVEL SECURITY (D1-2)`); failed = true; }
console.log(failed ? "migration guard FAILED" : `migration guard ok (${files.length} files)`);
process.exit(failed ? 1 : 0);
```

Sửa `package.json` root — thêm vào `verify`:
```json
"lint:migrations": "node scripts/check-migrations.mjs",
"verify": "npm run lint:versions && npm run lint:scope && npm run lint:secrets && npm run lint:migrations && npm run typecheck && npm run test"
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run scripts/migration-guards.test.mjs && npm run lint:migrations`
Expected: 5 test PASS; guard in `migration guard ok (1 files)` (chỉ có `0000_init_extensions.sql`).

- [ ] **Step 5: Commit**

```bash
git add scripts package.json
git commit -m "ci: guard migrations for workspace_id and row level security"
```

---

### Task 2: ID, Actor và lỗi domain

**Files:**
- Create: `packages/domain/package.json`, `packages/domain/tsconfig.json`, `packages/domain/src/ids.ts`, `packages/domain/src/actor.ts`, `packages/domain/src/errors.ts`
- Test: `packages/domain/src/actor.test.ts`

**Interfaces:**
- Produces:
  - `type Id = string & { readonly __brand: "Id" }`; `newId(): Id`; `isId(v: unknown): v is Id`
  - `type Actor = { kind: "user"; userId: Id } | { kind: "agent"; agentRunId: Id; agentVersionId: Id } | { kind: "system"; reason: string }`
  - `isUserActor(a: Actor): a is Extract<Actor,{kind:"user"}>`; `isAgentActor(...)`
  - `DomainError`, `TenantViolationError`, `InvalidTransitionError`, `ApprovalIntegrityError`

- [ ] **Step 1: Viết failing test**

`packages/domain/src/actor.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { newId, isId } from "./ids.js";
import { isAgentActor, isUserActor, type Actor } from "./actor.js";
import { ApprovalIntegrityError, TenantViolationError } from "./errors.js";

describe("ids", () => {
  it("generates unique, sortable v7 uuids", () => {
    const a = newId(); const b = newId();
    expect(a).not.toBe(b);
    expect(isId(a)).toBe(true);
    expect(a < b || a > b).toBe(true);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("rejects non-uuid values", () => {
    expect(isId("nope")).toBe(false);
    expect(isId(42)).toBe(false);
  });
});

describe("actor", () => {
  const user: Actor = { kind: "user", userId: newId() };
  const agent: Actor = { kind: "agent", agentRunId: newId(), agentVersionId: newId() };

  it("distinguishes a user from an agent", () => {
    expect(isUserActor(user)).toBe(true);
    expect(isUserActor(agent)).toBe(false);
    expect(isAgentActor(agent)).toBe(true);
  });
});

describe("errors", () => {
  it("carries a stable code for logging", () => {
    expect(new TenantViolationError("x").code).toBe("TENANT_VIOLATION");
    expect(new ApprovalIntegrityError("x").code).toBe("APPROVAL_INTEGRITY");
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run packages/domain/src/actor.test.ts`
Expected: FAIL — không resolve được `./ids.js`.

- [ ] **Step 3: Viết implementation tối thiểu**

`packages/domain/package.json` — **không dependency runtime nào ngoài zod**:
```json
{
  "name": "@smos/domain",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "zod": "4.4.3" }
}
```

`packages/domain/src/ids.ts`:
```ts
import { randomUUID } from "node:crypto";

export type Id = string & { readonly __brand: "Id" };

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** UUID v7 so ids sort by creation time, which keeps audit reads cheap. */
export function newId(): Id {
  const bytes = Buffer.from(randomUUID().replace(/-/g, ""), "hex");
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}` as Id;
}

export function isId(value: unknown): value is Id {
  return typeof value === "string" && UUID_V7.test(value);
}
```

`packages/domain/src/actor.ts`:
```ts
import type { Id } from "./ids.js";

/**
 * Actor kind is the single thing that decides whether an approval decision
 * is legitimate. An agent can never be the actor on an ApprovalDecision
 * (blueprint section 13.1); the database enforces this too.
 */
export type Actor =
  | { kind: "user"; userId: Id }
  | { kind: "agent"; agentRunId: Id; agentVersionId: Id }
  | { kind: "system"; reason: string };

export function isUserActor(a: Actor): a is Extract<Actor, { kind: "user" }> { return a.kind === "user"; }
export function isAgentActor(a: Actor): a is Extract<Actor, { kind: "agent" }> { return a.kind === "agent"; }
```

`packages/domain/src/errors.ts`:
```ts
export abstract class DomainError extends Error {
  abstract readonly code: string;
  constructor(message: string) { super(message); this.name = new.target.name; }
}
export class TenantViolationError extends DomainError { readonly code = "TENANT_VIOLATION"; }
export class InvalidTransitionError extends DomainError { readonly code = "INVALID_TRANSITION"; }
export class ApprovalIntegrityError extends DomainError { readonly code = "APPROVAL_INTEGRITY"; }
export class PublicationIntegrityError extends DomainError { readonly code = "PUBLICATION_INTEGRITY"; }
export class AgentNotActivatedError extends DomainError { readonly code = "AGENT_NOT_ACTIVATED"; }
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run packages/domain/src/actor.test.ts`
Expected: PASS — 5 test.

- [ ] **Step 5: Commit**

```bash
git add packages/domain package.json package-lock.json
git commit -m "feat(domain): add branded ids, actor kinds and domain errors"
```

---

### Task 3: Lifecycle state machine — E2

**Files:**
- Create: `packages/domain/src/lifecycle.ts`
- Test: `packages/domain/src/lifecycle.test.ts`

**Interfaces:**
- Consumes: `Actor` (Task 2), `InvalidTransitionError`
- Produces:
  - `type LifecycleState` — 11 state chính + 4 state ngang
  - `canTransition(from: LifecycleState, to: LifecycleState): boolean`
  - `applyTransition(input: TransitionInput): TransitionRecord`
  - `TransitionInput = { from, to, actor: Actor, reason: string, correlationId: Id, version: number, hasApprovalDecision?: boolean }`
  - `TransitionRecord = { from, to, actor, reason, correlationId, version, occurredAt: Date }`

- [ ] **Step 1: Viết failing test**

`packages/domain/src/lifecycle.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { newId } from "./ids.js";
import { applyTransition, canTransition, MAIN_STATES, type LifecycleState } from "./lifecycle.js";
import { InvalidTransitionError } from "./errors.js";
import type { Actor } from "./actor.js";

const user: Actor = { kind: "user", userId: newId() };
const agent: Actor = { kind: "agent", agentRunId: newId(), agentVersionId: newId() };
const base = { actor: user, reason: "test", correlationId: newId(), version: 1 };

describe("canTransition — happy path", () => {
  it("walks the full main sequence", () => {
    for (let i = 0; i < MAIN_STATES.length - 1; i++) {
      expect(canTransition(MAIN_STATES[i]!, MAIN_STATES[i + 1]!)).toBe(true);
    }
  });
});

describe("canTransition — rejections", () => {
  it("refuses to skip a stage", () => {
    expect(canTransition("DRAFT", "APPROVED")).toBe(false);
    expect(canTransition("IN_PROGRESS", "EXECUTING")).toBe(false);
  });
  it("refuses to go backwards except the two allowed rework edges", () => {
    expect(canTransition("COMPLETED", "DRAFT")).toBe(false);
    expect(canTransition("INTERNAL_REVIEW", "IN_PROGRESS")).toBe(true);
    expect(canTransition("WAITING_APPROVAL", "IN_PROGRESS")).toBe(true);
  });
  it("allows any live state to become BLOCKED or CANCELLED", () => {
    expect(canTransition("RESEARCHING", "BLOCKED")).toBe(true);
    expect(canTransition("SCHEDULED", "CANCELLED")).toBe(true);
  });
  it("refuses to leave a terminal state", () => {
    expect(canTransition("FAILED_TERMINAL", "IN_PROGRESS")).toBe(false);
    expect(canTransition("COMPLETED", "MEASURING")).toBe(false);
  });
});

describe("applyTransition — APPROVED is special", () => {
  it("refuses APPROVED without an approval decision", () => {
    expect(() => applyTransition({ ...base, from: "WAITING_APPROVAL", to: "APPROVED", hasApprovalDecision: false }))
      .toThrow(InvalidTransitionError);
  });
  it("refuses APPROVED when the actor is an agent", () => {
    expect(() => applyTransition({ ...base, actor: agent, from: "WAITING_APPROVAL", to: "APPROVED", hasApprovalDecision: true }))
      .toThrow(/agent/i);
  });
  it("accepts APPROVED from a user with a decision", () => {
    const record = applyTransition({ ...base, from: "WAITING_APPROVAL", to: "APPROVED", hasApprovalDecision: true });
    expect(record.to).toBe("APPROVED");
    expect(record.occurredAt).toBeInstanceOf(Date);
  });
});

describe("applyTransition — record completeness", () => {
  it("always records actor, reason, correlationId and version", () => {
    const record = applyTransition({ ...base, from: "DRAFT", to: "RESEARCHING" });
    expect(record).toMatchObject({ from: "DRAFT", to: "RESEARCHING", reason: "test", version: 1 });
    expect(record.correlationId).toBe(base.correlationId);
  });
  it("rejects an empty reason", () => {
    expect(() => applyTransition({ ...base, reason: "  ", from: "DRAFT", to: "RESEARCHING" })).toThrow(/reason/i);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run packages/domain/src/lifecycle.test.ts`
Expected: FAIL — không resolve được `./lifecycle.js`.

- [ ] **Step 3: Viết implementation tối thiểu**

`packages/domain/src/lifecycle.ts`:
```ts
import { isAgentActor, type Actor } from "./actor.js";
import { InvalidTransitionError } from "./errors.js";
import type { Id } from "./ids.js";

export const MAIN_STATES = [
  "DRAFT", "RESEARCHING", "PLANNED", "IN_PROGRESS", "INTERNAL_REVIEW",
  "WAITING_APPROVAL", "APPROVED", "SCHEDULED", "EXECUTING", "MEASURING", "COMPLETED",
] as const;

export const SIDE_STATES = ["BLOCKED", "FAILED_RETRYABLE", "FAILED_TERMINAL", "CANCELLED"] as const;

export type MainState = (typeof MAIN_STATES)[number];
export type SideState = (typeof SIDE_STATES)[number];
export type LifecycleState = MainState | SideState;

const TERMINAL: ReadonlySet<LifecycleState> = new Set(["COMPLETED", "FAILED_TERMINAL", "CANCELLED"]);

/** The only two backward edges: QA veto, and a rejected approval. */
const REWORK_EDGES: ReadonlyArray<[LifecycleState, LifecycleState]> = [
  ["INTERNAL_REVIEW", "IN_PROGRESS"],
  ["WAITING_APPROVAL", "IN_PROGRESS"],
];

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  if (from === to) return false;
  if (TERMINAL.has(from)) return false;
  if (to === "BLOCKED" || to === "CANCELLED" || to === "FAILED_RETRYABLE" || to === "FAILED_TERMINAL") return true;
  if (from === "BLOCKED" || from === "FAILED_RETRYABLE") return MAIN_STATES.includes(to as MainState);
  if (REWORK_EDGES.some(([f, t]) => f === from && t === to)) return true;
  const i = MAIN_STATES.indexOf(from as MainState);
  const j = MAIN_STATES.indexOf(to as MainState);
  return i >= 0 && j === i + 1;
}

export interface TransitionInput {
  from: LifecycleState;
  to: LifecycleState;
  actor: Actor;
  reason: string;
  correlationId: Id;
  version: number;
  hasApprovalDecision?: boolean | undefined;
}

export interface TransitionRecord {
  from: LifecycleState; to: LifecycleState; actor: Actor;
  reason: string; correlationId: Id; version: number; occurredAt: Date;
}

export function applyTransition(input: TransitionInput): TransitionRecord {
  if (input.reason.trim().length === 0) {
    throw new InvalidTransitionError("A transition reason is required and cannot be blank");
  }
  if (!canTransition(input.from, input.to)) {
    throw new InvalidTransitionError(`Transition ${input.from} -> ${input.to} is not allowed`);
  }
  if (input.to === "APPROVED") {
    if (input.hasApprovalDecision !== true) {
      throw new InvalidTransitionError("APPROVED requires a recorded ApprovalDecision");
    }
    if (isAgentActor(input.actor)) {
      throw new InvalidTransitionError("An agent actor can never approve; only a user can");
    }
  }
  return {
    from: input.from, to: input.to, actor: input.actor, reason: input.reason,
    correlationId: input.correlationId, version: input.version, occurredAt: new Date(),
  };
}
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run packages/domain/src/lifecycle.test.ts`
Expected: PASS — 10 test. **Đây là bằng chứng E2.**

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/lifecycle.ts packages/domain/src/lifecycle.test.ts
git commit -m "feat(domain): add lifecycle state machine with approval guard"
```

---

### Task 4: Migration nền — workspace, RLS, audit append-only

**Files:**
- Create: `infra/migrations/0001_core_tenancy.sql`
- Test: `packages/db/src/rls.test.ts`

**Interfaces:**
- Produces: bảng `workspace`, `user_account`, `audit_log`; role `smos_app` (không BYPASSRLS); session var `app.workspace_id`

- [ ] **Step 1: Viết failing test**

`packages/db/src/rls.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createDbPool } from "./client.js";

const url = process.env["DATABASE_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5432/smos";
const pool = createDbPool(url);
const db = createDb(pool);
const A = "11111111-1111-7111-8111-111111111111";
const B = "22222222-2222-7222-8222-222222222222";

beforeAll(async () => {
  await db.execute(sql`insert into workspace (id, name) values (${A}::uuid, 'A'), (${B}::uuid, 'B') on conflict do nothing`);
});
afterAll(async () => { await pool.end(); });

describe("row level security", () => {
  it("is enabled on audit_log", async () => {
    const r = await db.execute(sql`select relrowsecurity from pg_class where relname = 'audit_log'`);
    expect((r.rows[0] as { relrowsecurity: boolean }).relrowsecurity).toBe(true);
  });

  it("hides rows belonging to another workspace", async () => {
    const client = await pool.connect();
    try {
      await client.query("set role smos_app");
      await client.query("select set_config('app.workspace_id', $1, false)", [A]);
      await client.query(
        `insert into audit_log (id, workspace_id, event_type, actor_kind, payload)
         values (gen_random_uuid(), $1, 'test.a', 'system', '{}'::jsonb)`, [A]);
      await client.query("select set_config('app.workspace_id', $1, false)", [B]);
      const seen = await client.query("select count(*)::int as n from audit_log where event_type = 'test.a'");
      expect(seen.rows[0].n).toBe(0);
    } finally {
      await client.query("reset role").catch(() => undefined);
      client.release();
    }
  });

  it("refuses UPDATE and DELETE on audit_log (append-only)", async () => {
    const client = await pool.connect();
    try {
      await client.query("set role smos_app");
      await client.query("select set_config('app.workspace_id', $1, false)", [A]);
      await expect(client.query("update audit_log set event_type = 'tampered'")).rejects.toThrow(/append-only|permission denied/i);
      await expect(client.query("delete from audit_log")).rejects.toThrow(/append-only|permission denied/i);
    } finally {
      await client.query("reset role").catch(() => undefined);
      client.release();
    }
  });

  it("gives the app role no BYPASSRLS", async () => {
    const r = await db.execute(sql`select rolbypassrls from pg_roles where rolname = 'smos_app'`);
    expect((r.rows[0] as { rolbypassrls: boolean }).rolbypassrls).toBe(false);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run packages/db/src/rls.test.ts`
Expected: FAIL — `relation "workspace" does not exist`.

- [ ] **Step 3: Viết migration**

`infra/migrations/0001_core_tenancy.sql`:
```sql
-- Application role. Deliberately NOT superuser and NOT BYPASSRLS (ADR-007).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smos_app') THEN
    CREATE ROLE smos_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS workspace (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_account (
  id          uuid PRIMARY KEY,
  email       text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspace(id),
  event_type     text NOT NULL,
  actor_kind     text NOT NULL CHECK (actor_kind IN ('user','agent','system')),
  actor_user_id  uuid REFERENCES user_account(id),
  actor_run_id   uuid,
  subject_type   text,
  subject_id     uuid,
  correlation_id uuid,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_ws_time_idx ON audit_log (workspace_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_subject_idx ON audit_log (workspace_id, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS audit_log_correlation_idx ON audit_log (workspace_id, correlation_id);

-- Append-only. Two independent mechanisms so revoking one is not enough.
CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only; % is not permitted', TG_OP;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_mutation ON audit_log;
CREATE TRIGGER audit_log_no_mutation
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_tenant_isolation ON audit_log;
CREATE POLICY audit_log_tenant_isolation ON audit_log
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

GRANT USAGE ON SCHEMA public TO smos_app;
GRANT SELECT, INSERT ON audit_log TO smos_app;
REVOKE UPDATE, DELETE ON audit_log FROM smos_app;
GRANT SELECT ON workspace, user_account TO smos_app;
```

- [ ] **Step 4: Áp migration và chạy test**

Run:
```bash
docker compose exec -T db psql -U smos -d smos -f /dev/stdin < infra/migrations/0001_core_tenancy.sql
npx vitest run packages/db/src/rls.test.ts
```
Expected: PASS — 4 test. Đây là nền của **E8** và một phần **E12**.

- [ ] **Step 5: Xác minh migration guard vẫn xanh**

Run: `npm run lint:migrations`
Expected: `migration guard ok (2 files)`. Nếu FAILED thì có bảng thiếu `workspace_id` hoặc thiếu RLS — sửa migration, không sửa guard.

- [ ] **Step 6: Commit**

```bash
git add infra/migrations/0001_core_tenancy.sql packages/db/src/rls.test.ts
git commit -m "feat(db): add workspace, append-only audit log and rls policy"
```

---

### Task 5: Tenant scope helper

**Files:**
- Create: `packages/db/src/tenant-scope.ts`
- Test: `packages/db/src/tenant-scope.test.ts`

**Interfaces:**
- Consumes: `Db` (P0 Task 6), `TenantViolationError`
- Produces: `withTenant<T>(pool: Pool, workspaceId: Id, fn: (tx: TenantTx) => Promise<T>): Promise<T>` với `TenantTx = { query(text: string, values?: unknown[]): Promise<QueryResult> }`

- [ ] **Step 1: Viết failing test**

`packages/db/src/tenant-scope.test.ts`:
```ts
import { afterAll, describe, expect, it } from "vitest";
import { createDbPool } from "./client.js";
import { withTenant } from "./tenant-scope.js";

const url = process.env["DATABASE_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5432/smos";
const pool = createDbPool(url);
const A = "11111111-1111-7111-8111-111111111111";

afterAll(async () => { await pool.end(); });

describe("withTenant", () => {
  it("sets the RLS session variable for the duration of the callback", async () => {
    const value = await withTenant(pool, A, async (tx) => {
      const r = await tx.query("select current_setting('app.workspace_id', true) as ws");
      return r.rows[0].ws;
    });
    expect(value).toBe(A);
  });

  it("rolls back when the callback throws", async () => {
    await expect(withTenant(pool, A, async (tx) => {
      await tx.query(
        `insert into audit_log (id, workspace_id, event_type, actor_kind, payload)
         values (gen_random_uuid(), $1, 'rollback.probe', 'system', '{}'::jsonb)`, [A]);
      throw new Error("boom");
    })).rejects.toThrow("boom");

    const after = await withTenant(pool, A, (tx) =>
      tx.query("select count(*)::int as n from audit_log where event_type = 'rollback.probe'"));
    expect(after.rows[0].n).toBe(0);
  });

  it("rejects a workspace id that is not a uuid", async () => {
    await expect(withTenant(pool, "not-a-uuid" as never, async () => undefined)).rejects.toThrow(/workspace/i);
  });

  it("resets the role even when the callback throws", async () => {
    await withTenant(pool, A, async () => undefined).catch(() => undefined);
    const client = await pool.connect();
    const r = await client.query("select current_user as u");
    client.release();
    expect(r.rows[0].u).not.toBe("smos_app");
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run packages/db/src/tenant-scope.test.ts`
Expected: FAIL — không resolve được `./tenant-scope.js`.

- [ ] **Step 3: Viết implementation tối thiểu**

`packages/db/src/tenant-scope.ts`:
```ts
import type pg from "pg";
import { isId, type Id } from "@smos/domain";
import { TenantViolationError } from "@smos/domain";

export interface TenantTx {
  query(text: string, values?: unknown[]): Promise<pg.QueryResult>;
}

/**
 * Every database access in the application goes through this. It opens a
 * transaction, drops to the non-BYPASSRLS role, and sets the session
 * variable the RLS policies read. Anything the callback does is therefore
 * confined to one workspace by PostgreSQL itself, not by our SQL (ADR-007).
 */
export async function withTenant<T>(
  pool: pg.Pool,
  workspaceId: Id,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!isId(workspaceId)) {
    throw new TenantViolationError("A valid workspace id is required to open a tenant scope");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role smos_app");
    await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await fn({ query: (text, values) => client.query(text, values as never) });
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
```

Thêm `"@smos/domain": "*"` vào `dependencies` của `packages/db/package.json`.

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run packages/db/src/tenant-scope.test.ts`
Expected: PASS — 4 test. `set local role` và `set_config(..., true)` đều gắn với transaction nên tự khôi phục khi commit/rollback.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/tenant-scope.ts packages/db/src/tenant-scope.test.ts packages/db/package.json
git commit -m "feat(db): add transactional tenant scope that drives rls"
```

---

### Task 6: Campaign aggregate và migration

**Files:**
- Create: `packages/domain/src/campaign.ts`, `infra/migrations/0002_campaign.sql`
- Test: `packages/domain/src/campaign.test.ts`

**Interfaces:**
- Consumes: `lifecycle`, `ids`, `Actor`
- Produces:
  - `Campaign = { id: Id; workspaceId: Id; goalId: Id; name: string; state: LifecycleState; version: number; createdAt: Date; updatedAt: Date }`
  - `createCampaign(input: { workspaceId: Id; goalId: Id; name: string; actor: Actor; correlationId: Id }): { campaign: Campaign; transition: TransitionRecord }`
  - `transitionCampaign(campaign: Campaign, to: LifecycleState, opts: { actor: Actor; reason: string; correlationId: Id; hasApprovalDecision?: boolean }): { campaign: Campaign; transition: TransitionRecord }`

- [ ] **Step 1: Viết failing test**

`packages/domain/src/campaign.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { newId } from "./ids.js";
import { createCampaign, transitionCampaign } from "./campaign.js";
import { InvalidTransitionError } from "./errors.js";
import type { Actor } from "./actor.js";

const user: Actor = { kind: "user", userId: newId() };
const agent: Actor = { kind: "agent", agentRunId: newId(), agentVersionId: newId() };
const seed = () => createCampaign({ workspaceId: newId(), goalId: newId(), name: "Ra mắt gói tư vấn", actor: user, correlationId: newId() });

describe("createCampaign", () => {
  it("starts in DRAFT at version 1", () => {
    const { campaign } = seed();
    expect(campaign.state).toBe("DRAFT");
    expect(campaign.version).toBe(1);
  });
  it("rejects a blank name", () => {
    expect(() => createCampaign({ workspaceId: newId(), goalId: newId(), name: "   ", actor: user, correlationId: newId() }))
      .toThrow(/name/i);
  });
});

describe("transitionCampaign", () => {
  it("bumps version and returns a transition record", () => {
    const { campaign } = seed();
    const next = transitionCampaign(campaign, "RESEARCHING", { actor: agent, reason: "orchestrator dispatch", correlationId: newId() });
    expect(next.campaign.state).toBe("RESEARCHING");
    expect(next.campaign.version).toBe(2);
    expect(next.transition.actor).toEqual(agent);
  });

  it("never mutates the input campaign", () => {
    const { campaign } = seed();
    transitionCampaign(campaign, "RESEARCHING", { actor: user, reason: "x", correlationId: newId() });
    expect(campaign.state).toBe("DRAFT");
    expect(campaign.version).toBe(1);
  });

  it("refuses an illegal jump", () => {
    const { campaign } = seed();
    expect(() => transitionCampaign(campaign, "EXECUTING", { actor: user, reason: "x", correlationId: newId() }))
      .toThrow(InvalidTransitionError);
  });

  it("refuses APPROVED driven by an agent", () => {
    let c = seed().campaign;
    for (const to of ["RESEARCHING","PLANNED","IN_PROGRESS","INTERNAL_REVIEW","WAITING_APPROVAL"] as const) {
      c = transitionCampaign(c, to, { actor: agent, reason: "step", correlationId: newId() }).campaign;
    }
    expect(() => transitionCampaign(c, "APPROVED", { actor: agent, reason: "self approve", correlationId: newId(), hasApprovalDecision: true }))
      .toThrow(/agent/i);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run packages/domain/src/campaign.test.ts`
Expected: FAIL — không resolve được `./campaign.js`.

- [ ] **Step 3: Viết implementation tối thiểu**

`packages/domain/src/campaign.ts`:
```ts
import type { Actor } from "./actor.js";
import { DomainError } from "./errors.js";
import { newId, type Id } from "./ids.js";
import { applyTransition, type LifecycleState, type TransitionRecord } from "./lifecycle.js";

class CampaignValidationError extends DomainError { readonly code = "CAMPAIGN_INVALID"; }

export interface Campaign {
  readonly id: Id; readonly workspaceId: Id; readonly goalId: Id;
  readonly name: string; readonly state: LifecycleState; readonly version: number;
  readonly createdAt: Date; readonly updatedAt: Date;
}

export function createCampaign(input: {
  workspaceId: Id; goalId: Id; name: string; actor: Actor; correlationId: Id;
}): { campaign: Campaign; transition: TransitionRecord } {
  if (input.name.trim().length === 0) throw new CampaignValidationError("Campaign name cannot be blank");
  const now = new Date();
  const campaign: Campaign = {
    id: newId(), workspaceId: input.workspaceId, goalId: input.goalId,
    name: input.name.trim(), state: "DRAFT", version: 1, createdAt: now, updatedAt: now,
  };
  const transition = applyTransition({
    from: "DRAFT", to: "DRAFT", actor: input.actor, reason: "campaign created",
    correlationId: input.correlationId, version: 1,
  } as never as Parameters<typeof applyTransition>[0]);
  return { campaign, transition: { ...transition, from: "DRAFT", to: "DRAFT" } };
}

export function transitionCampaign(
  campaign: Campaign,
  to: LifecycleState,
  opts: { actor: Actor; reason: string; correlationId: Id; hasApprovalDecision?: boolean | undefined },
): { campaign: Campaign; transition: TransitionRecord } {
  const transition = applyTransition({
    from: campaign.state, to, actor: opts.actor, reason: opts.reason,
    correlationId: opts.correlationId, version: campaign.version + 1,
    hasApprovalDecision: opts.hasApprovalDecision,
  });
  return {
    campaign: { ...campaign, state: to, version: campaign.version + 1, updatedAt: transition.occurredAt },
    transition,
  };
}
```

> **Lưu ý cho implementer**: `createCampaign` gọi `applyTransition` với `from === to === "DRAFT"`, mà `canTransition` từ chối `from === to`. Hãy **thêm một nhánh khởi tạo** vào `lifecycle.ts` thay vì ép kiểu: export thêm `createInitialTransition(input: Omit<TransitionInput,"from"|"to">): TransitionRecord` trả về record với `from: "DRAFT", to: "DRAFT"` mà không qua `canTransition`, rồi dùng nó ở đây và xoá phần `as never`. Cập nhật `lifecycle.test.ts` thêm một test cho hàm mới.

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run packages/domain/src/campaign.test.ts packages/domain/src/lifecycle.test.ts`
Expected: PASS — 6 test campaign + 11 test lifecycle (10 cũ + 1 mới cho `createInitialTransition`).

- [ ] **Step 5: Viết migration campaign**

`infra/migrations/0002_campaign.sql`:
```sql
CREATE TABLE IF NOT EXISTS goal (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  statement    text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE goal ENABLE ROW LEVEL SECURITY;
ALTER TABLE goal FORCE ROW LEVEL SECURITY;
CREATE POLICY goal_tenant_isolation ON goal
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE TABLE IF NOT EXISTS campaign (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  goal_id      uuid NOT NULL REFERENCES goal(id),
  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  state        text NOT NULL,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaign_ws_state_idx ON campaign (workspace_id, state);
ALTER TABLE campaign ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_tenant_isolation ON campaign
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON goal, campaign TO smos_app;
```

Run: `docker compose exec -T db psql -U smos -d smos -f /dev/stdin < infra/migrations/0002_campaign.sql && npm run lint:migrations`
Expected: migration áp thành công; guard in `migration guard ok (3 files)`.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/campaign.ts packages/domain/src/campaign.test.ts packages/domain/src/lifecycle.ts packages/domain/src/lifecycle.test.ts infra/migrations/0002_campaign.sql
git commit -m "feat(domain): add campaign aggregate with immutable transitions"
```

---

### Task 7: Content, version và citation

**Files:**
- Create: `packages/domain/src/content.ts`, `infra/migrations/0003_content.sql`
- Test: `packages/domain/src/content.test.ts`

**Interfaces:**
- Produces:
  - `VerificationStatus = "VERIFIED" | "INFERRED" | "HYPOTHESIS" | "UNVERIFIED"`
  - `SourceCitation = { id: Id; url: string; accessedAt: Date; excerpt: string; verificationStatus: VerificationStatus }`
  - `ContentVersion = { id: Id; workspaceId: Id; contentItemId: Id; versionNumber: number; body: string; publicationContent: string | null; citations: SourceCitation[]; qualityScore: number | null }`
  - `addVersion(item: ContentItem, input: {...}): ContentVersion`

- [ ] **Step 1: Viết failing test**

`packages/domain/src/content.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { newId } from "./ids.js";
import { addVersion, createContentItem, canBeVerified } from "./content.js";

const ws = newId();
const item = () => createContentItem({ workspaceId: ws, campaignId: newId(), kind: "social_post", title: "Bài giới thiệu" });

describe("addVersion", () => {
  it("numbers versions from 1 upward", () => {
    const it0 = item();
    const v1 = addVersion(it0, { body: "nội dung", publicationContent: null, citations: [], qualityScore: null });
    const v2 = addVersion({ ...it0, latestVersionNumber: v1.versionNumber }, { body: "nội dung 2", publicationContent: null, citations: [], qualityScore: null });
    expect(v1.versionNumber).toBe(1);
    expect(v2.versionNumber).toBe(2);
  });

  it("rejects an empty body", () => {
    expect(() => addVersion(item(), { body: "  ", publicationContent: null, citations: [], qualityScore: null }))
      .toThrow(/body/i);
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
    expect(canBeVerified([{ id: newId(), url: "https://a.test", accessedAt: new Date(), excerpt: "e", verificationStatus: "UNVERIFIED" }])).toBe(false);
  });
  it("is true only when every citation is VERIFIED", () => {
    expect(canBeVerified([{ id: newId(), url: "https://a.test", accessedAt: new Date(), excerpt: "e", verificationStatus: "VERIFIED" }])).toBe(true);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run packages/domain/src/content.test.ts`
Expected: FAIL — không resolve được `./content.js`.

- [ ] **Step 3: Viết implementation tối thiểu**

`packages/domain/src/content.ts`:
```ts
import { DomainError } from "./errors.js";
import { newId, type Id } from "./ids.js";

class ContentValidationError extends DomainError { readonly code = "CONTENT_INVALID"; }

export type VerificationStatus = "VERIFIED" | "INFERRED" | "HYPOTHESIS" | "UNVERIFIED";
export type ContentKind = "social_post" | "email" | "landing_page" | "long_form" | "faq";

export interface SourceCitation {
  id: Id; url: string; accessedAt: Date; excerpt: string; verificationStatus: VerificationStatus;
}

export interface ContentItem {
  id: Id; workspaceId: Id; campaignId: Id; kind: ContentKind; title: string; latestVersionNumber: number;
}

export interface ContentVersion {
  id: Id; workspaceId: Id; contentItemId: Id; versionNumber: number;
  body: string;
  /** Verbatim text that will be published. Null until an agent sets it. */
  publicationContent: string | null;
  citations: SourceCitation[];
  /** Display and QA signal only. NEVER used to grant execution permission. */
  qualityScore: number | null;
  createdAt: Date;
}

export function createContentItem(input: { workspaceId: Id; campaignId: Id; kind: ContentKind; title: string }): ContentItem {
  if (input.title.trim().length === 0) throw new ContentValidationError("Content title cannot be blank");
  return { id: newId(), ...input, title: input.title.trim(), latestVersionNumber: 0 };
}

export function addVersion(item: ContentItem, input: {
  body: string; publicationContent: string | null; citations: SourceCitation[]; qualityScore: number | null;
}): ContentVersion {
  if (input.body.trim().length === 0) throw new ContentValidationError("Content body cannot be blank");
  return {
    id: newId(), workspaceId: item.workspaceId, contentItemId: item.id,
    versionNumber: item.latestVersionNumber + 1, body: input.body,
    publicationContent: input.publicationContent, citations: input.citations,
    qualityScore: input.qualityScore, createdAt: new Date(),
  };
}

/** A claim is only VERIFIED when every citation backing it is VERIFIED. */
export function canBeVerified(citations: SourceCitation[]): boolean {
  return citations.length > 0 && citations.every((c) => c.verificationStatus === "VERIFIED");
}
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run packages/domain/src/content.test.ts`
Expected: PASS — 6 test.

- [ ] **Step 5: Viết migration**

`infra/migrations/0003_content.sql`:
```sql
CREATE TABLE IF NOT EXISTS content_item (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  campaign_id  uuid NOT NULL REFERENCES campaign(id),
  kind         text NOT NULL CHECK (kind IN ('social_post','email','landing_page','long_form','faq')),
  title        text NOT NULL CHECK (length(btrim(title)) > 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE content_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_item FORCE ROW LEVEL SECURITY;
CREATE POLICY content_item_tenant_isolation ON content_item
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE TABLE IF NOT EXISTS content_version (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES workspace(id),
  content_item_id     uuid NOT NULL REFERENCES content_item(id),
  version_number      integer NOT NULL CHECK (version_number > 0),
  body                text NOT NULL CHECK (length(btrim(body)) > 0),
  publication_content text,
  quality_score       integer CHECK (quality_score BETWEEN 0 AND 100),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_item_id, version_number)
);
ALTER TABLE content_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_version FORCE ROW LEVEL SECURITY;
CREATE POLICY content_version_tenant_isolation ON content_version
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE TABLE IF NOT EXISTS source_citation (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES workspace(id),
  content_version_id  uuid NOT NULL REFERENCES content_version(id),
  url                 text NOT NULL,
  accessed_at         timestamptz NOT NULL,
  excerpt             text NOT NULL,
  verification_status text NOT NULL CHECK (verification_status IN ('VERIFIED','INFERRED','HYPOTHESIS','UNVERIFIED')),
  created_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE source_citation ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_citation FORCE ROW LEVEL SECURITY;
CREATE POLICY source_citation_tenant_isolation ON source_citation
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON content_item, content_version, source_citation TO smos_app;
```

Run: `docker compose exec -T db psql -U smos -d smos -f /dev/stdin < infra/migrations/0003_content.sql && npm run lint:migrations`
Expected: `migration guard ok (4 files)`.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/content.ts packages/domain/src/content.test.ts infra/migrations/0003_content.sql
git commit -m "feat(domain): add content versioning with source citations"
```

---

### Task 8: Approval — bất biến cưỡng chế ở database (E3, E4)

Đây là task quan trọng nhất của P1.

**Files:**
- Create: `packages/domain/src/approval.ts`, `infra/migrations/0004_approval.sql`
- Test: `packages/domain/src/approval.test.ts`, `packages/db/src/approval-invariants.test.ts`

**Interfaces:**
- Produces:
  - `ApprovalRequest = { id; workspaceId; campaignId; contentVersionId; targetChannel; policyFlags: PolicyFlag[]; evidenceCitationIds: Id[]; estimatedImpact: string | null; createdAt }`
  - `assertRenderable(req: ApprovalRequest): void` — thiếu evidence/kênh đích ⇒ ném lỗi, UI không được render nút approve
  - `decideApproval(req, input: { actor: Actor; decision: "approve"|"reject"|"request_changes"; reason: string }): ApprovalDecision`

- [ ] **Step 1: Viết failing test — tầng domain**

`packages/domain/src/approval.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { newId } from "./ids.js";
import { assertRenderable, decideApproval, type ApprovalRequest } from "./approval.js";
import { ApprovalIntegrityError } from "./errors.js";
import type { Actor } from "./actor.js";

const user: Actor = { kind: "user", userId: newId() };
const agent: Actor = { kind: "agent", agentRunId: newId(), agentVersionId: newId() };
const system: Actor = { kind: "system", reason: "scheduler" };

const req = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: newId(), workspaceId: newId(), campaignId: newId(), contentVersionId: newId(),
  targetChannel: "meta_page", policyFlags: [], evidenceCitationIds: [newId()],
  estimatedImpact: "reach ~1.200", createdAt: new Date(), ...over,
});

describe("assertRenderable", () => {
  it("passes for a complete request", () => { expect(() => assertRenderable(req())).not.toThrow(); });
  it("refuses a request with no evidence", () => {
    expect(() => assertRenderable(req({ evidenceCitationIds: [] }))).toThrow(/evidence/i);
  });
  it("refuses a request with no target channel", () => {
    expect(() => assertRenderable(req({ targetChannel: "" }))).toThrow(/channel/i);
  });
});

describe("decideApproval", () => {
  it("records a user decision", () => {
    const d = decideApproval(req(), { actor: user, decision: "approve", reason: "nội dung đạt" });
    expect(d.decision).toBe("approve");
    expect(d.actorUserId).toBe(user.userId);
  });
  it("refuses an agent actor", () => {
    expect(() => decideApproval(req(), { actor: agent, decision: "approve", reason: "x" }))
      .toThrow(ApprovalIntegrityError);
  });
  it("refuses a system actor", () => {
    expect(() => decideApproval(req(), { actor: system, decision: "approve", reason: "x" }))
      .toThrow(ApprovalIntegrityError);
  });
  it("refuses a blank reason on reject", () => {
    expect(() => decideApproval(req(), { actor: user, decision: "reject", reason: " " })).toThrow(/reason/i);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run packages/domain/src/approval.test.ts`
Expected: FAIL — không resolve được `./approval.js`.

- [ ] **Step 3: Viết implementation tối thiểu**

`packages/domain/src/approval.ts`:
```ts
import { isUserActor, type Actor } from "./actor.js";
import { ApprovalIntegrityError } from "./errors.js";
import { newId, type Id } from "./ids.js";

export interface PolicyFlag { ruleId: string; ruleVersion: number; severity: "info" | "warn" | "block"; message: string; }

export interface ApprovalRequest {
  id: Id; workspaceId: Id; campaignId: Id; contentVersionId: Id;
  targetChannel: string; policyFlags: PolicyFlag[]; evidenceCitationIds: Id[];
  estimatedImpact: string | null; createdAt: Date;
}

export type ApprovalDecisionKind = "approve" | "reject" | "request_changes";

export interface ApprovalDecision {
  id: Id; workspaceId: Id; approvalRequestId: Id; actorUserId: Id;
  decision: ApprovalDecisionKind; reason: string; decidedAt: Date;
}

/**
 * Blueprint section 13.2: an approval request missing any required element
 * must not render an approve button. Callers assert before rendering.
 */
export function assertRenderable(req: ApprovalRequest): void {
  if (req.evidenceCitationIds.length === 0) {
    throw new ApprovalIntegrityError("Approval request has no evidence; it cannot be presented for approval");
  }
  if (req.targetChannel.trim().length === 0) {
    throw new ApprovalIntegrityError("Approval request has no target channel; it cannot be presented for approval");
  }
}

export function decideApproval(
  req: ApprovalRequest,
  input: { actor: Actor; decision: ApprovalDecisionKind; reason: string },
): ApprovalDecision {
  if (!isUserActor(input.actor)) {
    throw new ApprovalIntegrityError("Only a human user can decide an approval request");
  }
  if (input.reason.trim().length === 0) {
    throw new ApprovalIntegrityError("An approval decision requires a reason");
  }
  assertRenderable(req);
  return {
    id: newId(), workspaceId: req.workspaceId, approvalRequestId: req.id,
    actorUserId: input.actor.userId, decision: input.decision,
    reason: input.reason.trim(), decidedAt: new Date(),
  };
}
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run packages/domain/src/approval.test.ts`
Expected: PASS — 7 test.

- [ ] **Step 5: Viết migration với constraint cấp database**

`infra/migrations/0004_approval.sql`:
```sql
CREATE TABLE IF NOT EXISTS approval_request (
  id                 uuid PRIMARY KEY,
  workspace_id       uuid NOT NULL REFERENCES workspace(id),
  campaign_id        uuid NOT NULL REFERENCES campaign(id),
  content_version_id uuid NOT NULL REFERENCES content_version(id),
  target_channel     text NOT NULL CHECK (length(btrim(target_channel)) > 0),
  policy_flags       jsonb NOT NULL DEFAULT '[]'::jsonb,
  estimated_impact   text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE approval_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_request FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_request_tenant_isolation ON approval_request
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE TABLE IF NOT EXISTS approval_decision (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES workspace(id),
  approval_request_id uuid NOT NULL UNIQUE REFERENCES approval_request(id),
  -- E4: the actor must be a real user row. An agent has no user_account row,
  -- so an agent literally cannot satisfy this foreign key.
  actor_user_id       uuid NOT NULL REFERENCES user_account(id),
  actor_kind          text NOT NULL DEFAULT 'user' CHECK (actor_kind = 'user'),
  decision            text NOT NULL CHECK (decision IN ('approve','reject','request_changes')),
  reason              text NOT NULL CHECK (length(btrim(reason)) > 0),
  decided_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE approval_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_decision_tenant_isolation ON approval_decision
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- Approval decisions are a record of a human act; they are never edited.
CREATE OR REPLACE FUNCTION approval_decision_is_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'approval_decision is immutable; % is not permitted', TG_OP;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS approval_decision_no_mutation ON approval_decision;
CREATE TRIGGER approval_decision_no_mutation
  BEFORE UPDATE OR DELETE ON approval_decision
  FOR EACH ROW EXECUTE FUNCTION approval_decision_is_immutable();

GRANT SELECT, INSERT ON approval_request, approval_decision TO smos_app;
REVOKE UPDATE, DELETE ON approval_decision FROM smos_app;
GRANT UPDATE ON approval_request TO smos_app;
```

- [ ] **Step 6: Viết test bất biến ở tầng database (E3, E4)**

`packages/db/src/approval-invariants.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "./client.js";
import { withTenant } from "./tenant-scope.js";
import type { Id } from "@smos/domain";

const url = process.env["DATABASE_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5432/smos";
const pool = createDbPool(url);
const A = "11111111-1111-7111-8111-111111111111" as Id;
let requestId: string;

beforeAll(async () => {
  // Seed a full chain: goal -> campaign -> content -> version -> approval_request
  const c = await pool.connect();
  await c.query(`insert into workspace (id,name) values ($1,'A') on conflict do nothing`, [A]);
  const ids = await c.query(`
    with g as (insert into goal (id,workspace_id,statement) values (gen_random_uuid(),$1,'g') returning id),
         c as (insert into campaign (id,workspace_id,goal_id,name,state) select gen_random_uuid(),$1,g.id,'c','WAITING_APPROVAL' from g returning id),
         i as (insert into content_item (id,workspace_id,campaign_id,kind,title) select gen_random_uuid(),$1,c.id,'social_post','t' from c returning id, campaign_id),
         v as (insert into content_version (id,workspace_id,content_item_id,version_number,body,publication_content) select gen_random_uuid(),$1,i.id,1,'b','pub' from i returning id)
    insert into approval_request (id,workspace_id,campaign_id,content_version_id,target_channel)
    select gen_random_uuid(),$1,i.campaign_id,v.id,'meta_page' from i,v returning id`, [A]);
  requestId = ids.rows[0].id;
  c.release();
});
afterAll(async () => { await pool.end(); });

describe("approval invariants enforced by the database", () => {
  it("E4: refuses a decision whose actor is not a real user row", async () => {
    await expect(withTenant(pool, A, (tx) => tx.query(
      `insert into approval_decision (id,workspace_id,approval_request_id,actor_user_id,decision,reason)
       values (gen_random_uuid(),$1,$2,gen_random_uuid(),'approve','agent tried')`, [A, requestId],
    ))).rejects.toThrow(/foreign key|violates/i);
  });

  it("E4: refuses actor_kind other than user", async () => {
    await expect(withTenant(pool, A, (tx) => tx.query(
      `insert into approval_decision (id,workspace_id,approval_request_id,actor_user_id,actor_kind,decision,reason)
       values (gen_random_uuid(),$1,$2,gen_random_uuid(),'agent','approve','x')`, [A, requestId],
    ))).rejects.toThrow(/check|violates/i);
  });

  it("refuses a blank reason", async () => {
    const u = await pool.query(`insert into user_account (id,email,name) values (gen_random_uuid(),'a@test','A') returning id`);
    await expect(withTenant(pool, A, (tx) => tx.query(
      `insert into approval_decision (id,workspace_id,approval_request_id,actor_user_id,decision,reason)
       values (gen_random_uuid(),$1,$2,$3,'approve','   ')`, [A, requestId, u.rows[0].id],
    ))).rejects.toThrow(/check|violates/i);
  });

  it("refuses two decisions on one request", async () => {
    const u = await pool.query(`insert into user_account (id,email,name) values (gen_random_uuid(),'b@test','B') returning id`);
    await withTenant(pool, A, (tx) => tx.query(
      `insert into approval_decision (id,workspace_id,approval_request_id,actor_user_id,decision,reason)
       values (gen_random_uuid(),$1,$2,$3,'approve','ok')`, [A, requestId, u.rows[0].id]));
    await expect(withTenant(pool, A, (tx) => tx.query(
      `insert into approval_decision (id,workspace_id,approval_request_id,actor_user_id,decision,reason)
       values (gen_random_uuid(),$1,$2,$3,'reject','again')`, [A, requestId, u.rows[0].id],
    ))).rejects.toThrow(/unique|duplicate/i);
  });

  it("refuses UPDATE and DELETE on a recorded decision", async () => {
    await expect(withTenant(pool, A, (tx) => tx.query(`update approval_decision set decision='reject'`)))
      .rejects.toThrow(/immutable|permission denied/i);
    await expect(withTenant(pool, A, (tx) => tx.query(`delete from approval_decision`)))
      .rejects.toThrow(/immutable|permission denied/i);
  });
});
```

Run:
```bash
docker compose exec -T db psql -U smos -d smos -f /dev/stdin < infra/migrations/0004_approval.sql
npx vitest run packages/db/src/approval-invariants.test.ts
```
Expected: PASS — 5 test. **Đây là bằng chứng E4** và một nửa của **E3**.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/approval.ts packages/domain/src/approval.test.ts packages/db/src/approval-invariants.test.ts infra/migrations/0004_approval.sql
git commit -m "feat(domain): enforce approval integrity in domain and database"
```

---

### Task 9: Publication — E3 phần còn lại và idempotency

**Files:**
- Create: `packages/domain/src/publication.ts`, `infra/migrations/0005_publication.sql`
- Test: `packages/domain/src/publication.test.ts`, `packages/db/src/publication-invariants.test.ts`

**Interfaces:**
- Produces:
  - `buildPublication(input: { workspaceId; campaignId; contentVersion: ContentVersion; approvalDecisionId: Id; targetChannel: string }): Publication`
  - `Publication = { id; workspaceId; campaignId; contentVersionId; approvalDecisionId; publicationContent; contentHash; idempotencyKey; targetChannel; state: "prepared" }`
  - `hashPublicationContent(text: string): string`

- [ ] **Step 1: Viết failing test**

`packages/domain/src/publication.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { newId } from "./ids.js";
import { buildPublication, hashPublicationContent } from "./publication.js";
import { PublicationIntegrityError } from "./errors.js";
import type { ContentVersion } from "./content.js";

const version = (publicationContent: string | null): ContentVersion => ({
  id: newId(), workspaceId: newId(), contentItemId: newId(), versionNumber: 1,
  body: "thân bài", publicationContent, citations: [], qualityScore: 90, createdAt: new Date(),
});

const input = (v: ContentVersion) => ({
  workspaceId: v.workspaceId, campaignId: newId(), contentVersion: v,
  approvalDecisionId: newId(), targetChannel: "meta_page",
});

describe("buildPublication", () => {
  it("refuses a version without publicationContent", () => {
    expect(() => buildPublication(input(version(null)))).toThrow(PublicationIntegrityError);
  });
  it("refuses blank publicationContent", () => {
    expect(() => buildPublication(input(version("   ")))).toThrow(/publication content/i);
  });
  it("carries the exact text that will be published", () => {
    const p = buildPublication(input(version("Bài đăng thật")));
    expect(p.publicationContent).toBe("Bài đăng thật");
    expect(p.state).toBe("prepared");
  });
  it("hashes the content so execute time can detect drift", () => {
    const p = buildPublication(input(version("Bài đăng thật")));
    expect(p.contentHash).toBe(hashPublicationContent("Bài đăng thật"));
  });
  it("derives a stable idempotency key from decision and content", () => {
    const v = version("Bài đăng thật");
    const i = input(v);
    expect(buildPublication(i).idempotencyKey).toBe(buildPublication(i).idempotencyKey);
  });
  it("changes the idempotency key when the content changes", () => {
    const i1 = input(version("A")); const i2 = { ...i1, contentVersion: version("B") };
    expect(buildPublication(i1).idempotencyKey).not.toBe(buildPublication(i2).idempotencyKey);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run packages/domain/src/publication.test.ts`
Expected: FAIL — không resolve được `./publication.js`.

- [ ] **Step 3: Viết implementation tối thiểu**

`packages/domain/src/publication.ts`:
```ts
import { createHash } from "node:crypto";
import type { ContentVersion } from "./content.js";
import { PublicationIntegrityError } from "./errors.js";
import { newId, type Id } from "./ids.js";

export interface Publication {
  id: Id; workspaceId: Id; campaignId: Id; contentVersionId: Id;
  approvalDecisionId: Id; publicationContent: string; contentHash: string;
  idempotencyKey: string; targetChannel: string; state: "prepared";
  createdAt: Date;
}

export function hashPublicationContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The Publication Artifact Contract. A publication cannot exist without the
 * verbatim text and without a recorded approval decision. This is what stops
 * a connector from posting an internal brief to a real page (threat T2).
 */
export function buildPublication(input: {
  workspaceId: Id; campaignId: Id; contentVersion: ContentVersion;
  approvalDecisionId: Id; targetChannel: string;
}): Publication {
  const text = input.contentVersion.publicationContent;
  if (text === null || text.trim().length === 0) {
    throw new PublicationIntegrityError("A publication requires non-empty publication content");
  }
  const contentHash = hashPublicationContent(text);
  return {
    id: newId(), workspaceId: input.workspaceId, campaignId: input.campaignId,
    contentVersionId: input.contentVersion.id, approvalDecisionId: input.approvalDecisionId,
    publicationContent: text, contentHash,
    idempotencyKey: createHash("sha256").update(`${input.approvalDecisionId}:${contentHash}`).digest("hex"),
    targetChannel: input.targetChannel, state: "prepared", createdAt: new Date(),
  };
}
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run packages/domain/src/publication.test.ts`
Expected: PASS — 6 test.

- [ ] **Step 5: Migration và test bất biến DB**

`infra/migrations/0005_publication.sql`:
```sql
CREATE TABLE IF NOT EXISTS publication (
  id                   uuid PRIMARY KEY,
  workspace_id         uuid NOT NULL REFERENCES workspace(id),
  campaign_id          uuid NOT NULL REFERENCES campaign(id),
  content_version_id   uuid NOT NULL REFERENCES content_version(id),
  -- E3: a publication is impossible without a recorded human approval.
  approval_decision_id uuid NOT NULL REFERENCES approval_decision(id),
  publication_content  text NOT NULL CHECK (length(btrim(publication_content)) > 0),
  content_hash         text NOT NULL,
  idempotency_key      text NOT NULL UNIQUE,
  target_channel       text NOT NULL,
  state                text NOT NULL CHECK (state IN ('prepared','executing','succeeded','failed')),
  external_id          text,
  permalink            text,
  evidence             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE publication FORCE ROW LEVEL SECURITY;
CREATE POLICY publication_tenant_isolation ON publication
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON publication TO smos_app;
```

`packages/db/src/publication-invariants.test.ts` — hai test cốt lõi:
```ts
import { afterAll, describe, expect, it } from "vitest";
import { createDbPool } from "./client.js";
import { withTenant } from "./tenant-scope.js";
import type { Id } from "@smos/domain";

const url = process.env["DATABASE_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5432/smos";
const pool = createDbPool(url);
const A = "11111111-1111-7111-8111-111111111111" as Id;
afterAll(async () => { await pool.end(); });

describe("publication invariants", () => {
  it("E3: refuses a publication without an approval_decision_id", async () => {
    await expect(withTenant(pool, A, (tx) => tx.query(
      `insert into publication (id,workspace_id,campaign_id,content_version_id,publication_content,content_hash,idempotency_key,target_channel,state)
       select gen_random_uuid(),$1,c.id,v.id,'x','h','k1','meta_page','prepared'
       from campaign c, content_version v where c.workspace_id=$1 and v.workspace_id=$1 limit 1`, [A],
    ))).rejects.toThrow(/null value|not-null/i);
  });

  it("refuses a duplicate idempotency key", async () => {
    const insert = (key: string) => withTenant(pool, A, (tx) => tx.query(
      `insert into publication (id,workspace_id,campaign_id,content_version_id,approval_decision_id,publication_content,content_hash,idempotency_key,target_channel,state)
       select gen_random_uuid(),$1,c.id,v.id,d.id,'x','h',$2,'meta_page','prepared'
       from campaign c, content_version v, approval_decision d
       where c.workspace_id=$1 and v.workspace_id=$1 and d.workspace_id=$1 limit 1`, [A, key]));
    await insert("dup-key-1");
    await expect(insert("dup-key-1")).rejects.toThrow(/unique|duplicate/i);
  });
});
```

Run:
```bash
docker compose exec -T db psql -U smos -d smos -f /dev/stdin < infra/migrations/0005_publication.sql
npx vitest run packages/db/src/publication-invariants.test.ts
```
Expected: PASS — 2 test. **Hoàn tất E3.**

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/publication.ts packages/domain/src/publication.test.ts packages/db/src/publication-invariants.test.ts infra/migrations/0005_publication.sql
git commit -m "feat(domain): add publication artifact contract with idempotency"
```

---

### Task 10: Agent registry và bất biến activation

**Files:**
- Create: `packages/domain/src/agent-registry.ts`, `infra/migrations/0006_agent_registry.sql`
- Test: `packages/domain/src/agent-registry.test.ts`

**Interfaces:**
- Produces:
  - `M1_ACTIVATED_AGENTS = ["orchestrator","research","content","qa_brand_safety"] as const`
  - `ALL_AGENT_ROLES` — 15 role
  - `assertActivated(role: AgentRole, registry: AgentRegistryEntry[]): void` — ném `AgentNotActivatedError`
  - `AgentRegistryEntry = { role: AgentRole; versionId: Id; activated: boolean; toolAllowlist: string[]; prohibitedActions: string[] }`

- [ ] **Step 1: Viết failing test**

`packages/domain/src/agent-registry.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { newId } from "./ids.js";
import { ALL_AGENT_ROLES, M1_ACTIVATED_AGENTS, assertActivated, type AgentRegistryEntry } from "./agent-registry.js";
import { AgentNotActivatedError } from "./errors.js";

const registry: AgentRegistryEntry[] = ALL_AGENT_ROLES.map((role) => ({
  role, versionId: newId(),
  activated: (M1_ACTIVATED_AGENTS as readonly string[]).includes(role),
  toolAllowlist: [], prohibitedActions: [],
}));

describe("agent registry", () => {
  it("declares all fifteen roles", () => { expect(ALL_AGENT_ROLES).toHaveLength(15); });

  it("activates exactly four in M1", () => {
    expect(M1_ACTIVATED_AGENTS).toHaveLength(4);
    expect(registry.filter((e) => e.activated)).toHaveLength(4);
  });

  it("has no duplicate roles", () => {
    expect(new Set(ALL_AGENT_ROLES).size).toBe(ALL_AGENT_ROLES.length);
  });

  it("allows dispatching an activated agent", () => {
    expect(() => assertActivated("content", registry)).not.toThrow();
  });

  it("refuses dispatching a non-activated agent", () => {
    expect(() => assertActivated("paid_media_advisor", registry)).toThrow(AgentNotActivatedError);
  });

  it("refuses dispatching a role absent from the registry", () => {
    expect(() => assertActivated("content", [])).toThrow(AgentNotActivatedError);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run packages/domain/src/agent-registry.test.ts`
Expected: FAIL — không resolve được `./agent-registry.js`.

- [ ] **Step 3: Viết implementation tối thiểu**

`packages/domain/src/agent-registry.ts`:
```ts
import { AgentNotActivatedError } from "./errors.js";
import type { Id } from "./ids.js";

export const ALL_AGENT_ROLES = [
  "orchestrator", "research", "icp_strategist", "brand_offer_strategist", "campaign_planner",
  "content", "creative_director", "seo_aeo", "social_distribution", "crm_lifecycle",
  "paid_media_advisor", "cro_experiment", "data_analyst", "qa_brand_safety", "integration_reliability",
] as const;

export type AgentRole = (typeof ALL_AGENT_ROLES)[number];

/** Blueprint 11.2.1. Exactly these four run in M1; the rest are contracts only. */
export const M1_ACTIVATED_AGENTS = ["orchestrator", "research", "content", "qa_brand_safety"] as const;

export interface AgentRegistryEntry {
  role: AgentRole; versionId: Id; activated: boolean;
  toolAllowlist: string[]; prohibitedActions: string[];
}

export function assertActivated(role: AgentRole, registry: AgentRegistryEntry[]): void {
  const entry = registry.find((e) => e.role === role);
  if (entry === undefined) throw new AgentNotActivatedError(`Agent role ${role} is not present in the registry`);
  if (!entry.activated) throw new AgentNotActivatedError(`Agent role ${role} is registered but not activated`);
}
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run packages/domain/src/agent-registry.test.ts`
Expected: PASS — 6 test.

- [ ] **Step 5: Migration**

`infra/migrations/0006_agent_registry.sql`:
```sql
CREATE TABLE IF NOT EXISTS agent_definition (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  role         text NOT NULL,
  mission      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, role)
);
ALTER TABLE agent_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definition FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_definition_tenant_isolation ON agent_definition
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE TABLE IF NOT EXISTS agent_version (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES workspace(id),
  agent_definition_id uuid NOT NULL REFERENCES agent_definition(id),
  version_number      integer NOT NULL CHECK (version_number > 0),
  activated           boolean NOT NULL DEFAULT false,
  tool_allowlist      jsonb NOT NULL DEFAULT '[]'::jsonb,
  prohibited_actions  jsonb NOT NULL DEFAULT '[]'::jsonb,
  prompt_version      text NOT NULL,
  model_version       text NOT NULL,
  budget_usd          numeric(10,4) NOT NULL CHECK (budget_usd > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_definition_id, version_number)
);
ALTER TABLE agent_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_version FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_version_tenant_isolation ON agent_version
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON agent_definition, agent_version TO smos_app;
```

Run: `docker compose exec -T db psql -U smos -d smos -f /dev/stdin < infra/migrations/0006_agent_registry.sql && npm run lint:migrations`
Expected: `migration guard ok (7 files)`.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/agent-registry.ts packages/domain/src/agent-registry.test.ts infra/migrations/0006_agent_registry.sql
git commit -m "feat(domain): add agent registry with m1 activation invariant"
```

---

### Task 11: Transactional outbox

**Files:**
- Create: `packages/db/src/outbox.ts`, `infra/migrations/0007_outbox.sql`
- Test: `packages/db/src/outbox.test.ts`

**Interfaces:**
- Consumes: `withTenant` (Task 5), `Queue` (P0 Task 7)
- Produces:
  - `enqueueInTransaction(tx: TenantTx, event: OutboxEvent): Promise<void>`
  - `drainOutbox(pool: Pool, queue: Queue, batchSize?: number): Promise<number>`
  - `OutboxEvent = { workspaceId: Id; eventType: string; payload: Record<string, unknown>; correlationId: Id }`

- [ ] **Step 1: Viết failing test**

`packages/db/src/outbox.test.ts`:
```ts
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDbPool } from "./client.js";
import { withTenant } from "./tenant-scope.js";
import { drainOutbox, enqueueInTransaction } from "./outbox.js";
import { newId, type Id } from "@smos/domain";

const url = process.env["DATABASE_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5432/smos";
const pool = createDbPool(url);
const A = "11111111-1111-7111-8111-111111111111" as Id;
afterAll(async () => { await pool.end(); });

const fakeQueue = () => { const sent: Array<{ name: string }> = []; return { sent, send: async (name: string) => { sent.push({ name }); return "id"; } }; };

describe("transactional outbox", () => {
  it("does not persist the event when the transaction rolls back", async () => {
    const correlationId = newId();
    await expect(withTenant(pool, A, async (tx) => {
      await enqueueInTransaction(tx, { workspaceId: A, eventType: "test.rollback", payload: {}, correlationId });
      throw new Error("boom");
    })).rejects.toThrow("boom");

    const rows = await withTenant(pool, A, (tx) =>
      tx.query("select count(*)::int as n from outbox where correlation_id = $1", [correlationId]));
    expect(rows.rows[0].n).toBe(0);
  });

  it("persists the event when the transaction commits", async () => {
    const correlationId = newId();
    await withTenant(pool, A, (tx) =>
      enqueueInTransaction(tx, { workspaceId: A, eventType: "test.commit", payload: { k: 1 }, correlationId }));
    const rows = await withTenant(pool, A, (tx) =>
      tx.query("select count(*)::int as n from outbox where correlation_id = $1", [correlationId]));
    expect(rows.rows[0].n).toBe(1);
  });

  it("drains pending events to the queue exactly once", async () => {
    const q = fakeQueue();
    const first = await drainOutbox(pool, q as never);
    const second = await drainOutbox(pool, q as never);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run packages/db/src/outbox.test.ts`
Expected: FAIL — không resolve được `./outbox.js`.

- [ ] **Step 3: Migration và implementation**

`infra/migrations/0007_outbox.sql`:
```sql
CREATE TABLE IF NOT EXISTS outbox (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspace(id),
  event_type     text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id uuid NOT NULL,
  published_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (created_at) WHERE published_at IS NULL;
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_tenant_isolation ON outbox
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON outbox TO smos_app;
```

`packages/db/src/outbox.ts`:
```ts
import type pg from "pg";
import { newId, type Id } from "@smos/domain";
import type { TenantTx } from "./tenant-scope.js";

export interface OutboxEvent {
  workspaceId: Id; eventType: string;
  payload: Record<string, unknown>; correlationId: Id;
}

/**
 * Writing the event inside the caller's transaction is the whole point: the
 * domain change and the intent to publish it either both land or neither does.
 */
export async function enqueueInTransaction(tx: TenantTx, event: OutboxEvent): Promise<void> {
  await tx.query(
    `insert into outbox (id, workspace_id, event_type, payload, correlation_id)
     values ($1, $2, $3, $4::jsonb, $5)`,
    [newId(), event.workspaceId, event.eventType, JSON.stringify(event.payload), event.correlationId],
  );
}

interface MinimalQueue { send(name: string, data: unknown): Promise<string | null>; }

/**
 * Drains with FOR UPDATE SKIP LOCKED so several workers can drain at once
 * without publishing the same row twice. Runs as the owner role because it
 * crosses workspaces by design.
 */
export async function drainOutbox(pool: pg.Pool, queue: MinimalQueue, batchSize = 100): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const pending = await client.query(
      `select id, workspace_id, event_type, payload, correlation_id
       from outbox where published_at is null
       order by created_at asc limit $1 for update skip locked`, [batchSize]);
    for (const row of pending.rows) {
      await queue.send(row.event_type, {
        workspaceId: row.workspace_id, payload: row.payload, correlationId: row.correlation_id,
      });
      await client.query("update outbox set published_at = now() where id = $1", [row.id]);
    }
    await client.query("commit");
    return pending.rowCount ?? 0;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run:
```bash
docker compose exec -T db psql -U smos -d smos -f /dev/stdin < infra/migrations/0007_outbox.sql
npx vitest run packages/db/src/outbox.test.ts
```
Expected: PASS — 3 test.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/outbox.ts packages/db/src/outbox.test.ts infra/migrations/0007_outbox.sql
git commit -m "feat(db): add transactional outbox with skip-locked draining"
```

---

### Task 12: Cross-workspace isolation suite — E8, E14

**Files:**
- Create: `packages/db/src/cross-tenant.test.ts`, `packages/testing/src/tenant-fixtures.ts`
- Test: chính file test trên

**Interfaces:**
- Produces: `seedTwoWorkspaces(pool: Pool): Promise<{ a: TenantFixture; b: TenantFixture }>` với `TenantFixture = { workspaceId: Id; userId: Id; campaignId: Id; contentVersionId: Id }`

- [ ] **Step 1: Viết failing test**

`packages/db/src/cross-tenant.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "./client.js";
import { withTenant } from "./tenant-scope.js";
import { seedTwoWorkspaces, type TenantFixture } from "@smos/testing";

const url = process.env["DATABASE_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5432/smos";
const pool = createDbPool(url);
let a: TenantFixture; let b: TenantFixture;

beforeAll(async () => { ({ a, b } = await seedTwoWorkspaces(pool)); });
afterAll(async () => { await pool.end(); });

const TENANT_TABLES = [
  "goal", "campaign", "content_item", "content_version", "source_citation",
  "approval_request", "approval_decision", "publication", "audit_log",
  "agent_definition", "agent_version", "outbox",
];

describe("E8/E14 cross-workspace isolation", () => {
  it.each(TENANT_TABLES)("%s: workspace B sees zero rows belonging to A", async (table) => {
    const inA = await withTenant(pool, a.workspaceId, (tx) => tx.query(`select count(*)::int as n from ${table}`));
    const bSeesA = await withTenant(pool, b.workspaceId, (tx) =>
      tx.query(`select count(*)::int as n from ${table} where workspace_id = $1`, [a.workspaceId]));
    expect(inA.rows[0].n).toBeGreaterThan(0);
    expect(bSeesA.rows[0].n).toBe(0);
  });

  it("reading A's campaign by id from B's scope returns nothing, not an error", async () => {
    const r = await withTenant(pool, b.workspaceId, (tx) =>
      tx.query("select id from campaign where id = $1", [a.campaignId]));
    // Must be indistinguishable from "does not exist" — no existence leak (T6).
    expect(r.rowCount).toBe(0);
  });

  it("writing a row tagged with A's workspace_id from B's scope is refused", async () => {
    await expect(withTenant(pool, b.workspaceId, (tx) => tx.query(
      `insert into goal (id, workspace_id, statement) values (gen_random_uuid(), $1, 'cross tenant')`,
      [a.workspaceId],
    ))).rejects.toThrow(/row-level security|violates/i);
  });

  it("every tenant table has RLS both enabled and forced", async () => {
    const r = await withTenant(pool, a.workspaceId, (tx) => tx.query(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where relname = any($1) and relkind = 'r'`, [TENANT_TABLES]));
    expect(r.rows).toHaveLength(TENANT_TABLES.length);
    for (const row of r.rows) {
      expect(row.relrowsecurity, `${row.relname} RLS enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} RLS forced`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run packages/db/src/cross-tenant.test.ts`
Expected: FAIL — không resolve được `@smos/testing`.

- [ ] **Step 3: Viết fixture**

`packages/testing/package.json`:
```json
{
  "name": "@smos/testing",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@smos/domain": "*" }
}
```

`packages/testing/src/tenant-fixtures.ts`:
```ts
import type pg from "pg";
import { newId, type Id } from "@smos/domain";

export interface TenantFixture {
  workspaceId: Id; userId: Id; campaignId: Id; contentVersionId: Id;
  approvalRequestId: Id; approvalDecisionId: Id;
}

async function seedOne(client: pg.PoolClient, label: string): Promise<TenantFixture> {
  const workspaceId = newId(); const userId = newId();
  await client.query(`insert into workspace (id,name) values ($1,$2)`, [workspaceId, label]);
  await client.query(`insert into user_account (id,email,name) values ($1,$2,$3)`, [userId, `${label}-${workspaceId}@test.local`, label]);
  const r = await client.query(`
    with g as (insert into goal (id,workspace_id,statement) values ($2,$1,'goal') returning id),
         c as (insert into campaign (id,workspace_id,goal_id,name,state) select $3,$1,g.id,'campaign','WAITING_APPROVAL' from g returning id),
         i as (insert into content_item (id,workspace_id,campaign_id,kind,title) select $4,$1,c.id,'social_post','title' from c returning id,campaign_id),
         v as (insert into content_version (id,workspace_id,content_item_id,version_number,body,publication_content) select $5,$1,i.id,1,'body','pub text' from i returning id),
         ar as (insert into approval_request (id,workspace_id,campaign_id,content_version_id,target_channel) select $6,$1,i.campaign_id,v.id,'meta_page' from i,v returning id),
         ad as (insert into approval_decision (id,workspace_id,approval_request_id,actor_user_id,decision,reason) select $7,$1,ar.id,$8,'approve','seeded' from ar returning id),
         sc as (insert into source_citation (id,workspace_id,content_version_id,url,accessed_at,excerpt,verification_status) select gen_random_uuid(),$1,v.id,'https://example.test',now(),'e','VERIFIED' from v returning id),
         ag as (insert into agent_definition (id,workspace_id,role,mission) values (gen_random_uuid(),$1,'content','write') returning id),
         av as (insert into agent_version (id,workspace_id,agent_definition_id,version_number,activated,prompt_version,model_version,budget_usd) select gen_random_uuid(),$1,ag.id,1,true,'p1','m1',1.0 from ag returning id),
         ob as (insert into outbox (id,workspace_id,event_type,correlation_id) values (gen_random_uuid(),$1,'seed.event',gen_random_uuid()) returning id),
         al as (insert into audit_log (id,workspace_id,event_type,actor_kind) values (gen_random_uuid(),$1,'seed.audit','system') returning id)
    insert into publication (id,workspace_id,campaign_id,content_version_id,approval_decision_id,publication_content,content_hash,idempotency_key,target_channel,state)
    select gen_random_uuid(),$1,i.campaign_id,v.id,ad.id,'pub text','hash-'||$1,'key-'||$1,'meta_page','prepared' from i,v,ad returning id`,
    [workspaceId, newId(), newId(), newId(), newId(), newId(), newId(), userId]);
  void r;
  return {
    workspaceId, userId,
    campaignId: (await client.query(`select id from campaign where workspace_id=$1 limit 1`, [workspaceId])).rows[0].id,
    contentVersionId: (await client.query(`select id from content_version where workspace_id=$1 limit 1`, [workspaceId])).rows[0].id,
    approvalRequestId: (await client.query(`select id from approval_request where workspace_id=$1 limit 1`, [workspaceId])).rows[0].id,
    approvalDecisionId: (await client.query(`select id from approval_decision where workspace_id=$1 limit 1`, [workspaceId])).rows[0].id,
  };
}

/** Seeds two fully-populated workspaces as the owner role, so RLS is not in play here. */
export async function seedTwoWorkspaces(pool: pg.Pool): Promise<{ a: TenantFixture; b: TenantFixture }> {
  const client = await pool.connect();
  try {
    return { a: await seedOne(client, "ws-a"), b: await seedOne(client, "ws-b") };
  } finally { client.release(); }
}
```

`packages/testing/src/index.ts`:
```ts
export { seedTwoWorkspaces, type TenantFixture } from "./tenant-fixtures.js";
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run packages/db/src/cross-tenant.test.ts`
Expected: PASS — 12 test tham số hoá + 3 test = **15 test**. Đây là bằng chứng **E8** và nền của **E14**.

- [ ] **Step 5: Commit**

```bash
git add packages/testing packages/db/src/cross-tenant.test.ts package.json package-lock.json
git commit -m "test(db): prove cross-workspace isolation on every tenant table"
```

---

### Task 13: Domain purity guard và audit traceability — E12

**Files:**
- Create: `scripts/check-domain-purity.mjs`, `packages/db/src/audit-trace.ts`
- Modify: `package.json` (thêm `lint:purity` vào `verify`)
- Test: `scripts/domain-purity.test.mjs`, `packages/db/src/audit-trace.test.ts`

**Interfaces:**
- Produces:
  - `findImpureImports(source: string): string[]`
  - `traceToGoal(pool: Pool, workspaceId: Id, publicationId: Id): Promise<TraceChain>` với `TraceChain = { publicationId; approvalDecisionId; approvalRequestId; contentVersionId; contentItemId; campaignId; goalId; auditEvents: Array<{ eventType: string; actorKind: string; occurredAt: Date }> }`

- [ ] **Step 1: Viết failing test**

`scripts/domain-purity.test.mjs`:
```js
import { describe, expect, it } from "vitest";
import { findImpureImports } from "./domain-purity.mjs";

describe("findImpureImports", () => {
  it("flags drizzle, pg, next and react", () => {
    const src = `import { sql } from "drizzle-orm";\nimport pg from "pg";\nimport React from "react";`;
    expect(findImpureImports(src)).toEqual(["drizzle-orm", "pg", "react"]);
  });
  it("allows node builtins and zod", () => {
    const src = `import { createHash } from "node:crypto";\nimport { z } from "zod";`;
    expect(findImpureImports(src)).toEqual([]);
  });
  it("allows sibling domain modules", () => {
    expect(findImpureImports(`import { newId } from "./ids.js";`)).toEqual([]);
  });
});
```

`packages/db/src/audit-trace.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "./client.js";
import { traceToGoal } from "./audit-trace.js";
import { seedTwoWorkspaces, type TenantFixture } from "@smos/testing";
import { withTenant } from "./tenant-scope.js";

const url = process.env["DATABASE_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5432/smos";
const pool = createDbPool(url);
let a: TenantFixture; let publicationId: string;

beforeAll(async () => {
  ({ a } = await seedTwoWorkspaces(pool));
  const r = await withTenant(pool, a.workspaceId, (tx) => tx.query("select id from publication limit 1"));
  publicationId = r.rows[0].id;
});
afterAll(async () => { await pool.end(); });

describe("E12 audit traceability", () => {
  it("walks from a publication back to its goal", async () => {
    const chain = await traceToGoal(pool, a.workspaceId, publicationId as never);
    expect(chain.publicationId).toBe(publicationId);
    expect(chain.approvalDecisionId).toBe(a.approvalDecisionId);
    expect(chain.campaignId).toBe(a.campaignId);
    expect(chain.goalId).toBeTruthy();
  });

  it("refuses to trace a publication from another workspace", async () => {
    const { b } = await seedTwoWorkspaces(pool);
    await expect(traceToGoal(pool, b.workspaceId, publicationId as never)).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run scripts/domain-purity.test.mjs packages/db/src/audit-trace.test.ts`
Expected: FAIL — không resolve được `./domain-purity.mjs` và `./audit-trace.js`.

- [ ] **Step 3: Viết implementation tối thiểu**

`scripts/domain-purity.mjs`:
```js
const FORBIDDEN = ["drizzle-orm", "pg", "next", "react", "react-dom", "pg-boss", "@smos/db"];
const IMPORT = /from\s+["']([^"']+)["']/g;

/** ADR-002 M2: the domain must not know how it is persisted or rendered. */
export function findImpureImports(source) {
  const hits = [];
  for (const m of source.matchAll(IMPORT)) {
    const spec = m[1];
    if (spec.startsWith(".") || spec.startsWith("node:")) continue;
    const root = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    if (FORBIDDEN.includes(root) || FORBIDDEN.includes(spec)) hits.push(spec);
  }
  return hits;
}
```

`scripts/check-domain-purity.mjs`:
```js
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findImpureImports } from "./domain-purity.mjs";

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

let failed = false;
for (const file of walk("packages/domain/src")) {
  for (const hit of findImpureImports(readFileSync(file, "utf8"))) {
    console.error(`${file}: domain must not import "${hit}" (ADR-002 M2)`);
    failed = true;
  }
}
console.log(failed ? "domain purity FAILED" : "domain purity ok");
process.exit(failed ? 1 : 0);
```

`packages/db/src/audit-trace.ts`:
```ts
import type pg from "pg";
import type { Id } from "@smos/domain";
import { withTenant } from "./tenant-scope.js";

export interface TraceChain {
  publicationId: Id; approvalDecisionId: Id; approvalRequestId: Id;
  contentVersionId: Id; contentItemId: Id; campaignId: Id; goalId: Id;
  auditEvents: Array<{ eventType: string; actorKind: string; occurredAt: Date }>;
}

/**
 * E12: given a publication, walk the whole chain back to the business goal.
 * Runs inside a tenant scope, so a publication in another workspace is simply
 * not found — the same answer as one that does not exist (threat T6).
 */
export async function traceToGoal(pool: pg.Pool, workspaceId: Id, publicationId: Id): Promise<TraceChain> {
  return withTenant(pool, workspaceId, async (tx) => {
    const r = await tx.query(
      `select p.id  as publication_id, p.approval_decision_id, ad.approval_request_id,
              p.content_version_id, cv.content_item_id, ci.campaign_id, c.goal_id
       from publication p
       join approval_decision ad on ad.id = p.approval_decision_id
       join content_version cv   on cv.id = p.content_version_id
       join content_item ci      on ci.id = cv.content_item_id
       join campaign c           on c.id  = ci.campaign_id
       where p.id = $1`, [publicationId]);
    if (r.rowCount === 0) throw new Error(`Publication ${publicationId} not found in this workspace`);
    const row = r.rows[0];
    const audit = await tx.query(
      `select event_type, actor_kind, occurred_at from audit_log
       where subject_id in ($1,$2,$3,$4) order by occurred_at asc`,
      [row.publication_id, row.approval_decision_id, row.campaign_id, row.goal_id]);
    return {
      publicationId: row.publication_id, approvalDecisionId: row.approval_decision_id,
      approvalRequestId: row.approval_request_id, contentVersionId: row.content_version_id,
      contentItemId: row.content_item_id, campaignId: row.campaign_id, goalId: row.goal_id,
      auditEvents: audit.rows.map((a) => ({ eventType: a.event_type, actorKind: a.actor_kind, occurredAt: a.occurred_at })),
    };
  });
}
```

Sửa `package.json` root:
```json
"lint:purity": "node scripts/check-domain-purity.mjs",
"verify": "npm run lint:versions && npm run lint:scope && npm run lint:secrets && npm run lint:migrations && npm run lint:purity && npm run typecheck && npm run test"
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run scripts/domain-purity.test.mjs packages/db/src/audit-trace.test.ts && npm run lint:purity`
Expected: 3 + 2 test PASS; guard in `domain purity ok`.

Xác minh guard thật sự bắt lỗi:
```bash
echo 'import { sql } from "drizzle-orm";' >> packages/domain/src/ids.ts
npm run lint:purity   # Expected: FAILED, exit 1
git checkout packages/domain/src/ids.ts
npm run lint:purity   # Expected: ok
```

- [ ] **Step 5: Chạy toàn bộ cổng verify**

Run: `npm run verify`
Expected: sáu dòng guard `ok`, typecheck 0 lỗi, toàn bộ test pass, exit **0**.

- [ ] **Step 6: Commit**

```bash
git add scripts packages/db/src/audit-trace.ts packages/db/src/audit-trace.test.ts package.json
git commit -m "feat(db): add audit traceability and enforce domain purity in ci"
```

---

## Acceptance Criteria

| # | Tiêu chí | Bằng chứng |
|---|---|---|
| B1 | State machine từ chối mọi transition bất hợp lệ | E2 — Task 3 |
| B2 | `APPROVED` không thể đạt tới thiếu `ApprovalDecision` | E3 — Task 3 (domain) + Task 9 (DB NOT NULL) |
| B3 | Agent không thể tạo `ApprovalDecision` | E4 — Task 8 (domain) + FK tới `user_account` (DB) |
| B4 | Mọi bảng tenant có `workspace_id` và RLS enabled **và** forced | E8 — Task 12, guard Task 1 |
| B5 | Workspace B không đọc/ghi được dữ liệu của A trên **12 bảng** | E8/E14 — Task 12 |
| B6 | Đọc resource của workspace khác trả rỗng, không lộ sự tồn tại | Task 12 |
| B7 | `audit_log` không UPDATE/DELETE được | Task 4 |
| B8 | Truy vết `publication_id` → `goal_id` | E12 — Task 13 |
| B9 | `packages/domain` không import Drizzle/pg/next/react | Task 13 guard |
| B10 | Outbox không persist khi transaction rollback | Task 11 |
| B11 | Agent chưa activated bị từ chối; đúng 4 agent activated ở M1 | Task 10 |
| B12 | `npm run verify` exit 0 | Task 13 Step 5 |

## Security Checks

- **T6 cross-workspace**: phòng thủ ba lớp. Test Task 12 chạy trên **mọi** bảng tenant, không phải mẫu.
- **T1 publish trái phép**: `publication.approval_decision_id NOT NULL` + FK. Không có đường nào tạo publication mà không có quyết định của người thật.
- **T11 sửa audit**: trigger + `REVOKE UPDATE, DELETE`. Hai cơ chế độc lập.
- `approval_decision` bất biến bằng trigger riêng.
- Role `smos_app` `NOBYPASSRLS`, kiểm bằng test.
- **Bất biến #4**: `quality_score` chỉ là cột dữ liệu, **không** xuất hiện trong bất kỳ điều kiện cấp quyền nào. Xác minh bằng `grep -rn "quality_score" packages/domain/src` — chỉ được thấy trong `content.ts` như một field.

## Tenancy Checks

D1-1 ✅ (guard Task 1) · D1-2 ✅ (RLS Task 4, dùng cho mọi bảng) · D1-4 ✅ (`audit_log.workspace_id NOT NULL` + RLS) · D1-6 ✅ (Task 12 trên 12 bảng) · D1-7 ✅ (không hard-code workspace, `withTenant` luôn nhận tham số).

D1-3 (agent context) và D1-5 (credential) thuộc **P2** và **P4** — P1 tạo nền schema.

## Audit Evidence

`audit_log` có `workspace_id`, `event_type`, `actor_kind`, `actor_user_id`, `correlation_id`, `subject_type`, `subject_id`, `payload`, `occurred_at`. Append-only hai lớp. `traceToGoal` chứng minh chuỗi truy vết chạy được.

## Observability Evidence

P1 chưa thêm trace mới — dùng lại auto-instrumentation `pg` từ P0, nên mọi query đã có span. P2 và P4 thêm span thủ công cho agent run và adapter.

## Rollback / Recovery

- Migration đánh số tăng dần, mỗi file idempotent (`IF NOT EXISTS`, `DROP ... IF EXISTS` trước `CREATE`), nên chạy lại an toàn.
- **Chưa có down-migration.** Ở M0/M1 dữ liệu là dữ liệu thử, rollback = `docker compose down -v` rồi chạy lại từ `0000`. Down-migration trở thành bắt buộc từ M2, khi có dữ liệu thật — ghi vào backlog M2.
- Mỗi task là một commit; `git revert` hoạt động ở tầng code.

## Non-Goals

Auth thật (P3 nối better-auth) · agent runtime (P2) · UI (P3) · adapter (P4) · Journey **dưới mọi hình thức** · consent ledger (M4) · analytics (M5) · down-migration (M2).

## Manual Verification

```bash
docker compose up -d db
for f in infra/migrations/*.sql; do docker compose exec -T db psql -U smos -d smos -f /dev/stdin < "$f"; done
npm run verify
```
Rồi kiểm bằng tay rằng RLS thật sự chặn:
```bash
docker compose exec -T db psql -U smos -d smos -c \
  "set role smos_app; select set_config('app.workspace_id','11111111-1111-7111-8111-111111111111',false); select count(*) from campaign;"
```
Expected: chỉ đếm campaign của workspace đó, không phải toàn bộ bảng.

## Browser Verification

Chưa áp dụng — P1 không có UI. Bắt đầu ở P3.

## Evidence Tiers

| Tier | P1 |
|---|---|
| **Source check** | ✅ guard version, scope, secret, migration, domain purity |
| **Local runtime** | ✅ E2, E3, E4, E8, E12 chạy trên PostgreSQL thật với RLS thật |
| **Sandbox integration** | ❌ Chưa có adapter — P4 |
| **Production verification** | ❌ Chưa có. Không tuyên bố production-ready |
