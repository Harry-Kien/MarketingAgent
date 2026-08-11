# P0 — Platform Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dựng nền tảng chạy được — monorepo, PostgreSQL, Drizzle, pg-boss, OpenTelemetry, health endpoint và CI quality gate — **không có bất kỳ business feature nào**.

**Architecture:** npm workspaces monorepo, một deployable modular monolith (`apps/web` + `apps/worker`) chia sẻ `packages/*`. PostgreSQL 17 + pgvector chạy qua Docker Compose local là source of truth duy nhất; pg-boss dùng chính database đó nên không có hạ tầng thứ hai. OpenTelemetry được khởi tạo ở tiến trình gốc của cả hai app trước khi bất kỳ module nào khác nạp.

**Tech Stack:** Node 24.14.0 · npm 11.9.0 workspaces · TypeScript 7.0.2 · Next.js 16.3.0 · React 19.2.8 · drizzle-orm 0.45.2 · drizzle-kit 0.31.10 · pg-boss 12.27.0 · @opentelemetry/sdk-node 0.221.0 · zod 4.4.3 · vitest 4.1.10 · PostgreSQL 17 + pgvector

## Global Constraints

- **Node `24.14.0`**, npm `11.9.0`. `engines.node` phải ghi `>=24.0.0`.
- **Mọi dependency pin exact version.** Cấm `^` và `~`. Cưỡng chế bằng Task 10.
- **ESM toàn bộ**: `"type": "module"` ở mọi package.
- TypeScript **strict** bật hết, gồm `noUncheckedIndexedAccess` và `exactOptionalPropertyTypes`.
- **Không Redis.** pg-boss chạy trong PostgreSQL (ADR-003).
- **Không** n8n, Dify, AutoGen, Inngest, Temporal, Prisma trong dependency.
- **Không** business feature trong P0. Không entity domain, không agent, không UI trang nghiệp vụ.
- **Không** billing, signup, provisioning, marketplace, white-label — kể cả route hay nút disabled (D1.b).
- Secret **chỉ** đọc từ env qua schema Zod. Không secret trong source, không secret trong log.
- Code, tên file, tên biến, commit message: **tiếng Anh**. Chuỗi hiển thị cho Founder: **tiếng Việt** qua lớp i18n (ADR-006).
- Mọi commit chạy được `npm run verify` xanh.

---

## File Structure Map

| Path | Trách nhiệm | Phụ thuộc | Public interface |
|---|---|---|---|
| `package.json` | Root workspace, script tổng | — | `npm run verify`, `dev`, `test` |
| `tsconfig.base.json` | Compiler option dùng chung | — | extends bởi mọi package |
| `.nvmrc` | Chốt Node version | — | — |
| `.gitattributes` | Chuẩn hoá EOL | — | — |
| `docker-compose.yml` | Postgres 17 + pgvector local | — | service `db` cổng 5432 |
| `packages/telemetry/src/index.ts` | Khởi tạo OTel, logger có redaction | `@opentelemetry/sdk-node` | `startTelemetry()`, `logger`, `redact()` |
| `packages/telemetry/src/redact.ts` | Che secret/PII trong log | — | `redact(value): unknown` |
| `packages/contracts/src/env.ts` | Schema env, validate lúc khởi động | `zod` | `serverEnv`, `ServerEnv` |
| `packages/contracts/src/index.ts` | Barrel export | — | re-export |
| `packages/db/src/client.ts` | Pool `pg` + instance Drizzle | `drizzle-orm`, `pg` | `createDbPool()`, `createDb()`, `Db` |
| `packages/db/src/schema/index.ts` | Barrel schema Drizzle (rỗng ở P0) | `drizzle-orm` | re-export |
| `packages/db/src/migrate.ts` | Migration runner | `drizzle-orm` | `runMigrations()` |
| `packages/db/drizzle.config.ts` | Cấu hình drizzle-kit | `drizzle-kit` | — |
| `infra/migrations/0000_init_extensions.sql` | `CREATE EXTENSION` | — | — |
| `packages/queue/src/index.ts` | Bọc pg-boss, chia sẻ transaction | `pg-boss` | `createQueue()`, `Queue` |
| `apps/worker/src/main.ts` | Entrypoint worker | telemetry, db, queue | — |
| `apps/web/src/app/layout.tsx` | Root layout Next | — | — |
| `apps/web/src/app/api/health/route.ts` | Liveness + readiness | db, queue | `GET /api/health` |
| `apps/web/instrumentation.ts` | Hook OTel của Next | telemetry | `register()` |
| `scripts/check-exact-versions.mjs` | Chặn `^`/`~` | — | exit code |
| `scripts/check-forbidden-scope.mjs` | Chặn D1.b và dependency cấm | — | exit code |
| `scripts/scan-secrets.mjs` | E10 secret scan | — | exit code |
| `.github/workflows/ci.yml` | CI gate | — | — |

**Files KHÔNG được chạm trong P0:** `docs/**` (đã commit ở baseline `8a37a72`), `.gitignore` (trừ Task 1 thêm `.gitattributes` là file mới).

---

### Task 1: Root workspace và TypeScript baseline

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.nvmrc`, `.gitattributes`
- Test: `scripts/check-exact-versions.mjs` (dùng lại ở Task 10)

**Interfaces:**
- Consumes: không
- Produces: npm workspace roots `apps/*` và `packages/*`; script `npm run verify`

- [ ] **Step 1: Tạo `.nvmrc` và `.gitattributes`**

`.nvmrc`:
```
24.14.0
```

`.gitattributes` — sửa cảnh báo LF→CRLF thấy ở baseline commit:
```
* text=auto eol=lf
*.png binary
*.woff2 binary
```

- [ ] **Step 2: Tạo `package.json` root**

```json
{
  "name": "solo-marketing-os",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.0.0" },
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "typecheck": "tsc --build --verbose",
    "test": "vitest run",
    "lint:versions": "node scripts/check-exact-versions.mjs",
    "lint:scope": "node scripts/check-forbidden-scope.mjs",
    "lint:secrets": "node scripts/scan-secrets.mjs",
    "verify": "npm run lint:versions && npm run lint:scope && npm run lint:secrets && npm run typecheck && npm run test"
  },
  "devDependencies": {
    "typescript": "7.0.2",
    "vitest": "4.1.10",
    "@types/node": "26.1.1"
  }
}
```

- [ ] **Step 3: Tạo `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "declaration": true,
    "composite": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 4: Cài dependency và xác minh Node**

Run: `node --version && npm install`
Expected: in ra `v24.14.0`; `npm install` kết thúc exit code 0; `node_modules/` xuất hiện và đã bị `.gitignore` bỏ qua.

- [ ] **Step 5: Xác minh `.gitattributes` có hiệu lực**

Run: `git add --renormalize . && git status --short`
Expected: không còn cảnh báo `LF will be replaced by CRLF`.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.base.json .nvmrc .gitattributes package-lock.json
git commit -m "chore: add npm workspace root and typescript baseline"
```

---

### Task 2: Env contract validate lúc khởi động

**Files:**
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/src/env.ts`, `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/env.test.ts`

**Interfaces:**
- Consumes: không
- Produces: `serverEnv: ServerEnv` (đã validate, đóng băng), `parseServerEnv(raw: Record<string,string|undefined>): ServerEnv`

- [ ] **Step 1: Viết failing test**

`packages/contracts/src/env.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseServerEnv } from "./env.js";

const valid = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://user:pw@127.0.0.1:5432/smos",
  OTEL_SERVICE_NAME: "smos-test",
};

describe("parseServerEnv", () => {
  it("accepts a valid environment", () => {
    const env = parseServerEnv(valid);
    expect(env.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(env.NODE_ENV).toBe("test");
  });

  it("rejects a missing DATABASE_URL", () => {
    const { DATABASE_URL, ...missing } = valid;
    expect(() => parseServerEnv(missing)).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() => parseServerEnv({ ...valid, DATABASE_URL: "mysql://x" }))
      .toThrow(/postgres/);
  });

  it("never includes the raw secret in the thrown message", () => {
    try {
      parseServerEnv({ ...valid, DATABASE_URL: "mysql://user:SUPERSECRET@h/db" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(String(error)).not.toContain("SUPERSECRET");
    }
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run packages/contracts/src/env.test.ts`
Expected: FAIL — `Failed to resolve import "./env.js"`.

- [ ] **Step 3: Viết implementation tối thiểu**

`packages/contracts/package.json`:
```json
{
  "name": "@smos/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "zod": "4.4.3" }
}
```

`packages/contracts/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src/**/*.ts"] }
```

`packages/contracts/src/env.ts`:
```ts
import { z } from "zod";

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  DATABASE_URL: z
    .string()
    .refine((v) => v.startsWith("postgres://") || v.startsWith("postgresql://"), {
      message: "DATABASE_URL must be a postgres:// connection string",
    }),
  OTEL_SERVICE_NAME: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * Validate the environment. The error message deliberately reports only
 * the failing key and its rule, never the received value, because these
 * values are secrets (threat T4).
 */
export function parseServerEnv(raw: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(raw);
  if (result.success) return Object.freeze(result.data);
  const detail = result.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid server environment -> ${detail}`);
}
```

`packages/contracts/src/index.ts`:
```ts
export { parseServerEnv, type ServerEnv } from "./env.js";
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run packages/contracts/src/env.test.ts`
Expected: PASS — 4 test.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts package.json package-lock.json
git commit -m "feat(contracts): validate server environment with zod at startup"
```

---

### Task 3: Log redaction

**Files:**
- Create: `packages/telemetry/package.json`, `packages/telemetry/tsconfig.json`, `packages/telemetry/src/redact.ts`
- Test: `packages/telemetry/src/redact.test.ts`

**Interfaces:**
- Consumes: không
- Produces: `redact(value: unknown): unknown` — thay giá trị của key nhạy cảm bằng `"[redacted]"`, đệ quy vào object và array

- [ ] **Step 1: Viết failing test**

`packages/telemetry/src/redact.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { redact } from "./redact.js";

describe("redact", () => {
  it("masks sensitive keys at any depth", () => {
    const input = {
      user: "kien",
      password: "hunter2",
      nested: { accessToken: "abc123", apiKey: "sk-live-xyz" },
    };
    expect(redact(input)).toEqual({
      user: "kien",
      password: "[redacted]",
      nested: { accessToken: "[redacted]", apiKey: "[redacted]" },
    });
  });

  it("masks connection strings that embed a password", () => {
    expect(redact("postgres://u:hunter2@localhost:5432/db"))
      .toBe("postgres://u:[redacted]@localhost:5432/db");
  });

  it("walks arrays", () => {
    expect(redact([{ token: "t1" }, { token: "t2" }]))
      .toEqual([{ token: "[redacted]" }, { token: "[redacted]" }]);
  });

  it("leaves ordinary values untouched", () => {
    expect(redact({ count: 3, ok: true, name: "campaign" }))
      .toEqual({ count: 3, ok: true, name: "campaign" });
  });

  it("does not loop forever on circular references", () => {
    const a: Record<string, unknown> = { name: "a" };
    a["self"] = a;
    expect(() => redact(a)).not.toThrow();
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run packages/telemetry/src/redact.test.ts`
Expected: FAIL — không resolve được `./redact.js`.

- [ ] **Step 3: Viết implementation tối thiểu**

`packages/telemetry/package.json`:
```json
{
  "name": "@smos/telemetry",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts", "./redact": "./src/redact.ts" },
  "dependencies": {
    "@opentelemetry/sdk-node": "0.221.0",
    "@opentelemetry/auto-instrumentations-node": "0.68.0",
    "@opentelemetry/resources": "2.4.0",
    "@opentelemetry/semantic-conventions": "1.42.0"
  }
}
```

`packages/telemetry/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src/**/*.ts"] }
```

`packages/telemetry/src/redact.ts`:
```ts
const SENSITIVE_KEY = /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential)/i;
const CONNECTION_STRING_PASSWORD = /(:\/\/[^:/@]+:)([^@]+)(@)/g;
export const REDACTED = "[redacted]";

/**
 * Remove secret-looking values before anything reaches a log sink or a
 * telemetry exporter (threat T4). Structure is preserved so logs stay
 * readable; only values are replaced.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return value.replace(CONNECTION_STRING_PASSWORD, `$1${REDACTED}$3`);
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(item, seen);
  }
  return out;
}
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run packages/telemetry/src/redact.test.ts`
Expected: PASS — 5 test.

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry package.json package-lock.json
git commit -m "feat(telemetry): redact secrets before they reach logs"
```

---

### Task 4: Khởi tạo OpenTelemetry và logger

**Files:**
- Create: `packages/telemetry/src/logger.ts`, `packages/telemetry/src/index.ts`
- Test: `packages/telemetry/src/logger.test.ts`

**Interfaces:**
- Consumes: `redact` từ Task 3
- Produces: `startTelemetry(opts: { serviceName: string; endpoint?: string }): Promise<() => Promise<void>>`; `logger.info/warn/error(msg: string, fields?: Record<string, unknown>): void`

- [ ] **Step 1: Viết failing test**

`packages/telemetry/src/logger.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  it("emits one JSON line per call", () => {
    const sink = vi.fn();
    createLogger(sink).info("campaign created", { campaignId: "c1" });
    expect(sink).toHaveBeenCalledOnce();
    const line = JSON.parse(sink.mock.calls[0]![0] as string);
    expect(line.level).toBe("info");
    expect(line.msg).toBe("campaign created");
    expect(line.campaignId).toBe("c1");
    expect(typeof line.time).toBe("string");
  });

  it("redacts sensitive fields", () => {
    const sink = vi.fn();
    createLogger(sink).error("auth failed", { apiKey: "sk-live-1", user: "kien" });
    const line = JSON.parse(sink.mock.calls[0]![0] as string);
    expect(line.apiKey).toBe("[redacted]");
    expect(line.user).toBe("kien");
  });

  it("never lets a field overwrite the reserved level key", () => {
    const sink = vi.fn();
    createLogger(sink).warn("x", { level: "sneaky" });
    const line = JSON.parse(sink.mock.calls[0]![0] as string);
    expect(line.level).toBe("warn");
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run packages/telemetry/src/logger.test.ts`
Expected: FAIL — không resolve được `./logger.js`.

- [ ] **Step 3: Viết implementation tối thiểu**

`packages/telemetry/src/logger.ts`:
```ts
import { redact } from "./redact.js";

export type LogLevel = "info" | "warn" | "error";
export type LogSink = (line: string) => void;

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(sink: LogSink = (line) => process.stdout.write(line + "\n")): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    const safe = (fields ? redact(fields) : {}) as Record<string, unknown>;
    // Reserved keys are written last so caller fields can never shadow them.
    sink(JSON.stringify({ ...safe, level, msg, time: new Date().toISOString() }));
  };
  return {
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

export const logger = createLogger();
```

`packages/telemetry/src/index.ts`:
```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export { logger, createLogger, type Logger } from "./logger.js";
export { redact, REDACTED } from "./redact.js";

export interface TelemetryOptions {
  serviceName: string;
  endpoint?: string | undefined;
}

/**
 * Must run before any instrumented module is imported, otherwise the
 * auto-instrumentation hooks miss them. Returns a shutdown function.
 */
export async function startTelemetry(opts: TelemetryOptions): Promise<() => Promise<void>> {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: opts.serviceName }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
  return () => sdk.shutdown();
}
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run packages/telemetry/src/logger.test.ts`
Expected: PASS — 3 test.

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry package-lock.json
git commit -m "feat(telemetry): add otel bootstrap and structured logger"
```

---

### Task 5: PostgreSQL local và extension

> ⚠ **BLOCKER HẠ TẦNG đã phát hiện 2026-08-11 — đọc trước khi bắt đầu task này.**
>
> Kiểm tra máy Founder cho kết quả:
>
> | Công cụ | Trạng thái |
> |---|---|
> | Node 24.14.0, npm 11.9.0 | ✅ có |
> | `docker` | ❌ **không cài** |
> | `psql` | ❌ không có trên PATH |
> | Service `PostgreSQL_For_Odoo` | ⚠ **đang chạy** — thuộc hệ thống Odoo của Founder |
> | `winget` | ✅ có, cài được |
>
> **Không được dùng `PostgreSQL_For_Odoo`.** Đó là database sản xuất của một hệ thống khác. Tạo database mới trong đó sẽ trộn lẫn dữ liệu, và migration của ta tạo role `smos_app` ở cấp cluster, ảnh hưởng cả Odoo.
>
> Ba lựa chọn, cần Founder chọn **trước khi** chạy Step 1:
>
> | | Cách | Đánh đổi |
> |---|---|---|
> | **A** (khuyến nghị) | `winget install Docker.DockerDesktop` | Đúng theo plan; cô lập hoàn toàn; cần WSL2 và một lần khởi động lại |
> | **B** | `winget install PostgreSQL.PostgreSQL.17` rồi cài `pgvector` thủ công | Không cần Docker; nhưng `pgvector` trên Windows phải build hoặc lấy binary rời — thêm việc |
> | **C** | Dùng PostgreSQL managed trên cloud (Neon/Supabase free tier) | Không cài gì; nhưng cần credential thật và test sẽ phụ thuộc mạng, trái với mục tiêu "local runtime evidence" của M0 |
>
> Nếu chọn **B** hoặc **C**, `docker-compose.yml` ở Step 1 được thay bằng hướng dẫn tương ứng và `.env.example` đổi `DATABASE_URL`. Phần còn lại của P0–P4 **không đổi** vì mọi thứ chỉ phụ thuộc `DATABASE_URL`.

**Files:**
- Create: `docker-compose.yml`, `infra/migrations/0000_init_extensions.sql`, `.env.example`
- Test: `scripts/check-db.mjs`

**Interfaces:**
- Consumes: không
- Produces: PostgreSQL 17 + pgvector tại `127.0.0.1:5432`, database `smos`

- [ ] **Step 1: Tạo `docker-compose.yml`**

```yaml
services:
  db:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: smos
      POSTGRES_PASSWORD: smos_local_dev
      POSTGRES_DB: smos
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U smos -d smos"]
      interval: 5s
      timeout: 5s
      retries: 20
volumes:
  pgdata:
```

- [ ] **Step 2: Tạo `.env.example`**

Đây là file **mẫu**, không chứa secret thật. `.gitignore` đã cho phép `!.env.example`.

```bash
NODE_ENV=development
DATABASE_URL=postgres://smos:smos_local_dev@127.0.0.1:5432/smos
OTEL_SERVICE_NAME=smos-web
```

- [ ] **Step 3: Tạo migration extension đầu tiên**

`infra/migrations/0000_init_extensions.sql` — ADR-002 ghi rõ `CREATE EXTENSION vector` phải viết tay:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

- [ ] **Step 4: Khởi động database và xác minh extension**

Run:
```bash
docker compose up -d db
docker compose exec -T db pg_isready -U smos -d smos
docker compose exec -T db psql -U smos -d smos -f /dev/stdin < infra/migrations/0000_init_extensions.sql
docker compose exec -T db psql -U smos -d smos -c "SELECT extname FROM pg_extension WHERE extname IN ('vector','pgcrypto') ORDER BY extname;"
```
Expected: `pg_isready` in `accepting connections`; câu SELECT cuối trả **2 dòng**: `pgcrypto`, `vector`.

- [ ] **Step 5: Xác minh `.env` thật bị ignore**

Run: `cp .env.example .env && git check-ignore -v .env`
Expected: in ra `.gitignore:...:.env` — file `.env` **không** vào git.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example infra/migrations/0000_init_extensions.sql
git commit -m "feat(infra): add local postgres 17 with pgvector and pgcrypto"
```

---

### Task 6: Drizzle client và migration runner

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/drizzle.config.ts`, `packages/db/src/client.ts`, `packages/db/src/schema/index.ts`, `packages/db/src/migrate.ts`
- Test: `packages/db/src/client.test.ts`

**Interfaces:**
- Consumes: `ServerEnv` (Task 2), `logger` (Task 4)
- Produces:
  - `createDbPool(url: string): Pool`
  - `createDb(pool: Pool): Db` với `Db = NodePgDatabase<typeof schema>`
  - `runMigrations(db: Db): Promise<void>`

- [ ] **Step 1: Viết failing test**

`packages/db/src/client.test.ts` — test tích hợp thật, cần database ở Task 5 đang chạy:
```ts
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, createDbPool } from "./client.js";

const url = process.env["DATABASE_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5432/smos";
const pool = createDbPool(url);
const db = createDb(pool);

afterAll(async () => { await pool.end(); });

describe("db client", () => {
  it("connects and runs a query", async () => {
    const rows = await db.execute(sql`select 1 as one`);
    expect(rows.rows[0]).toEqual({ one: 1 });
  });

  it("has the vector extension available", async () => {
    const rows = await db.execute(sql`select extname from pg_extension where extname = 'vector'`);
    expect(rows.rows).toHaveLength(1);
  });

  it("reports the expected major version", async () => {
    const rows = await db.execute(sql`show server_version_num`);
    const versionNum = Number((rows.rows[0] as { server_version_num: string }).server_version_num);
    expect(versionNum).toBeGreaterThanOrEqual(170000);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run packages/db/src/client.test.ts`
Expected: FAIL — không resolve được `./client.js`.

- [ ] **Step 3: Viết implementation tối thiểu**

`packages/db/package.json`:
```json
{
  "name": "@smos/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts", "./schema": "./src/schema/index.ts" },
  "dependencies": {
    "drizzle-orm": "0.45.2",
    "pg": "8.16.3"
  },
  "devDependencies": {
    "drizzle-kit": "0.31.10",
    "@types/pg": "8.15.7"
  }
}
```

`packages/db/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src/**/*.ts"] }
```

`packages/db/src/schema/index.ts` — rỗng có chủ đích ở P0; P1 sẽ điền:
```ts
// Schema tables are introduced in P1. P0 only proves the connection works.
export {};
```

`packages/db/src/client.ts`:
```ts
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

export type Db = NodePgDatabase<typeof schema>;

export function createDbPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000 });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}
```

`packages/db/src/migrate.ts`:
```ts
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./client.js";

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: "infra/migrations" });
}
```

`packages/db/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "../../infra/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env["DATABASE_URL"] ?? "" },
  strict: true,
  verbose: true,
});
```

`packages/db/src/index.ts`:
```ts
export { createDb, createDbPool, type Db } from "./client.js";
export { runMigrations } from "./migrate.js";
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `docker compose up -d db && npx vitest run packages/db/src/client.test.ts`
Expected: PASS — 3 test. Nếu fail vì connection refused, chạy lại Task 5 Step 4.

- [ ] **Step 5: Commit**

```bash
git add packages/db package.json package-lock.json
git commit -m "feat(db): add drizzle client and migration runner"
```

---

### Task 7: pg-boss queue chia sẻ database

**Files:**
- Create: `packages/queue/package.json`, `packages/queue/tsconfig.json`, `packages/queue/src/index.ts`
- Test: `packages/queue/src/index.test.ts`

**Interfaces:**
- Consumes: `DATABASE_URL`
- Produces:
  - `createQueue(url: string): Promise<Queue>`
  - `Queue = { send(name: string, data: unknown, opts?: { singletonKey?: string }): Promise<string | null>; work<T>(name: string, handler: (jobs: Array<{ data: T }>) => Promise<void>): Promise<string>; stop(): Promise<void>; boss: PgBoss }`

- [ ] **Step 1: Viết failing test**

`packages/queue/src/index.test.ts`:
```ts
import { afterAll, describe, expect, it } from "vitest";
import { createQueue, type Queue } from "./index.js";

const url = process.env["DATABASE_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5432/smos";
let queue: Queue;

afterAll(async () => { await queue?.stop(); });

describe("queue", () => {
  it("round-trips a job through postgres", async () => {
    queue = await createQueue(url);
    const received: string[] = [];
    await queue.work<{ id: string }>("test.echo", async (jobs) => {
      for (const job of jobs) received.push(job.data.id);
    });
    await queue.send("test.echo", { id: "job-1" });
    await vi.waitFor(() => expect(received).toContain("job-1"), { timeout: 10_000 });
  });

  it("deduplicates by singletonKey", async () => {
    const first = await queue.send("test.dedupe", { n: 1 }, { singletonKey: "same" });
    const second = await queue.send("test.dedupe", { n: 2 }, { singletonKey: "same" });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});
```

Thêm `import { vi } from "vitest";` vào dòng import đầu tiên.

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run packages/queue/src/index.test.ts`
Expected: FAIL — không resolve được `./index.js`.

- [ ] **Step 3: Viết implementation tối thiểu**

`packages/queue/package.json`:
```json
{
  "name": "@smos/queue",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "pg-boss": "12.27.0" }
}
```

`packages/queue/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src/**/*.ts"] }
```

`packages/queue/src/index.ts`:
```ts
import PgBoss from "pg-boss";

export interface SendOptions { singletonKey?: string | undefined; }

export interface Queue {
  send(name: string, data: unknown, opts?: SendOptions): Promise<string | null>;
  work<T>(name: string, handler: (jobs: Array<{ data: T }>) => Promise<void>): Promise<string>;
  stop(): Promise<void>;
  boss: PgBoss;
}

/**
 * pg-boss runs inside the same PostgreSQL instance as the domain data
 * (ADR-003). That is what makes the transactional outbox in P1 possible:
 * enqueueing a job and writing domain rows share one transaction.
 */
export async function createQueue(url: string): Promise<Queue> {
  const boss = new PgBoss({ connectionString: url, schema: "pgboss" });
  await boss.start();
  return {
    boss,
    async send(name, data, opts) {
      await boss.createQueue(name).catch(() => undefined);
      return boss.send(name, data as object, opts?.singletonKey ? { singletonKey: opts.singletonKey } : {});
    },
    async work(name, handler) {
      await boss.createQueue(name).catch(() => undefined);
      return boss.work(name, async (jobs) => { await handler(jobs as Array<{ data: never }>); });
    },
    stop: () => boss.stop({ graceful: true }),
  };
}
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run packages/queue/src/index.test.ts`
Expected: PASS — 2 test. Xác minh schema `pgboss` đã tạo:
`docker compose exec -T db psql -U smos -d smos -c "\dn pgboss"` → 1 dòng.

- [ ] **Step 5: Commit**

```bash
git add packages/queue package.json package-lock.json
git commit -m "feat(queue): add pg-boss wrapper running inside the app database"
```

---

### Task 8: Worker entrypoint

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/src/main.ts`
- Test: `apps/worker/src/main.test.ts`

**Interfaces:**
- Consumes: `startTelemetry`, `logger` (Task 4), `parseServerEnv` (Task 2), `createDbPool`/`createDb` (Task 6), `createQueue` (Task 7)
- Produces: `bootstrapWorker(env: ServerEnv): Promise<WorkerHandle>` với `WorkerHandle = { shutdown(): Promise<void> }`

- [ ] **Step 1: Viết failing test**

`apps/worker/src/main.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { bootstrapWorker } from "./main.js";
import { parseServerEnv } from "@smos/contracts";

describe("bootstrapWorker", () => {
  it("starts and shuts down cleanly", async () => {
    const env = parseServerEnv({
      NODE_ENV: "test",
      DATABASE_URL: process.env["DATABASE_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5432/smos",
      OTEL_SERVICE_NAME: "smos-worker-test",
    });
    const handle = await bootstrapWorker(env);
    expect(handle.shutdown).toBeTypeOf("function");
    await expect(handle.shutdown()).resolves.toBeUndefined();
  }, 30_000);
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run apps/worker/src/main.test.ts`
Expected: FAIL — không resolve được `./main.js`.

- [ ] **Step 3: Viết implementation tối thiểu**

`apps/worker/package.json`:
```json
{
  "name": "@smos/worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "dev": "node --experimental-strip-types src/main.ts" },
  "dependencies": {
    "@smos/contracts": "*",
    "@smos/db": "*",
    "@smos/queue": "*",
    "@smos/telemetry": "*"
  }
}
```

`apps/worker/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src/**/*.ts"] }
```

`apps/worker/src/main.ts`:
```ts
import { parseServerEnv, type ServerEnv } from "@smos/contracts";
import { createDb, createDbPool } from "@smos/db";
import { createQueue } from "@smos/queue";
import { logger, startTelemetry } from "@smos/telemetry";

export interface WorkerHandle { shutdown(): Promise<void>; }

export async function bootstrapWorker(env: ServerEnv): Promise<WorkerHandle> {
  const stopTelemetry = await startTelemetry({
    serviceName: env.OTEL_SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  });
  const pool = createDbPool(env.DATABASE_URL);
  const db = createDb(pool);
  const queue = await createQueue(env.DATABASE_URL);
  // db is held so P1/P2 handlers can use it; no job handlers exist yet in P0.
  void db;
  logger.info("worker started", { service: env.OTEL_SERVICE_NAME });

  return {
    async shutdown() {
      await queue.stop();
      await pool.end();
      await stopTelemetry();
      logger.info("worker stopped");
    },
  };
}

// Only run when executed directly, so tests can import without side effects.
if (process.argv[1]?.endsWith("main.ts")) {
  const handle = await bootstrapWorker(parseServerEnv(process.env));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => { void handle.shutdown().then(() => process.exit(0)); });
  }
}
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run apps/worker/src/main.test.ts`
Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add apps/worker package.json package-lock.json
git commit -m "feat(worker): add worker entrypoint with telemetry, db and queue"
```

---

### Task 9: Next.js app và health endpoint

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.ts`, `apps/web/instrumentation.ts`, `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx`, `apps/web/src/app/api/health/route.ts`, `apps/web/src/lib/health.ts`
- Test: `apps/web/src/lib/health.test.ts`

**Interfaces:**
- Consumes: `createDbPool`/`createDb` (Task 6), `logger` (Task 4)
- Produces: `checkHealth(deps: HealthDeps): Promise<HealthReport>` với
  `HealthDeps = { pingDb: () => Promise<void>; pingQueue: () => Promise<void> }`
  `HealthReport = { status: "ok" | "degraded"; checks: Array<{ name: string; ok: boolean; error?: string }> }`

- [ ] **Step 1: Viết failing test**

`apps/web/src/lib/health.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { checkHealth } from "./health.js";

const ok = () => Promise.resolve();
const fail = (m: string) => () => Promise.reject(new Error(m));

describe("checkHealth", () => {
  it("reports ok when every dependency answers", async () => {
    const report = await checkHealth({ pingDb: ok, pingQueue: ok });
    expect(report.status).toBe("ok");
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  it("reports degraded and names the failing dependency", async () => {
    const report = await checkHealth({ pingDb: fail("db down"), pingQueue: ok });
    expect(report.status).toBe("degraded");
    expect(report.checks.find((c) => c.name === "database")?.ok).toBe(false);
  });

  it("never leaks a connection string in the error field", async () => {
    const report = await checkHealth({
      pingDb: fail("connect ECONNREFUSED postgres://u:hunter2@h:5432/db"),
      pingQueue: ok,
    });
    expect(JSON.stringify(report)).not.toContain("hunter2");
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run apps/web/src/lib/health.test.ts`
Expected: FAIL — không resolve được `./health.js`.

- [ ] **Step 3: Viết implementation tối thiểu**

`apps/web/package.json`:
```json
{
  "name": "@smos/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "dev": "next dev --port 3000", "build": "next build", "start": "next start" },
  "dependencies": {
    "@smos/contracts": "*",
    "@smos/db": "*",
    "@smos/telemetry": "*",
    "next": "16.3.0",
    "react": "19.2.8",
    "react-dom": "19.2.8"
  },
  "devDependencies": {
    "@types/react": "19.2.7",
    "@types/react-dom": "19.2.4",
    "tailwindcss": "4.3.3",
    "@tailwindcss/postcss": "4.3.3"
  }
}
```

`apps/web/src/lib/health.ts`:
```ts
import { redact } from "@smos/telemetry";

export interface HealthDeps {
  pingDb: () => Promise<void>;
  pingQueue: () => Promise<void>;
}

export interface HealthCheck { name: string; ok: boolean; error?: string; }
export interface HealthReport { status: "ok" | "degraded"; checks: HealthCheck[]; }

async function probe(name: string, fn: () => Promise<void>): Promise<HealthCheck> {
  try {
    await fn();
    return { name, ok: true };
  } catch (error) {
    // Error text can carry a connection string, so it goes through redact (T4).
    return { name, ok: false, error: String(redact(String(error))) };
  }
}

export async function checkHealth(deps: HealthDeps): Promise<HealthReport> {
  const checks = await Promise.all([
    probe("database", deps.pingDb),
    probe("queue", deps.pingQueue),
  ]);
  return { status: checks.every((c) => c.ok) ? "ok" : "degraded", checks };
}
```

`apps/web/src/app/api/health/route.ts`:
```ts
import { sql } from "drizzle-orm";
import { parseServerEnv } from "@smos/contracts";
import { createDb, createDbPool } from "@smos/db";
import { checkHealth } from "../../../lib/health.js";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const env = parseServerEnv(process.env);
  const pool = createDbPool(env.DATABASE_URL);
  const db = createDb(pool);
  try {
    const report = await checkHealth({
      pingDb: async () => { await db.execute(sql`select 1`); },
      pingQueue: async () => { await db.execute(sql`select 1 from pgboss.version limit 1`); },
    });
    return Response.json(report, { status: report.status === "ok" ? 200 : 503 });
  } finally {
    await pool.end();
  }
}
```

`apps/web/instrumentation.ts`:
```ts
export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;
  const { startTelemetry } = await import("@smos/telemetry");
  await startTelemetry({
    serviceName: process.env["OTEL_SERVICE_NAME"] ?? "smos-web",
    endpoint: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  });
}
```

`apps/web/next.config.ts`:
```ts
import type { NextConfig } from "next";
const config: NextConfig = { reactStrictMode: true, transpilePackages: ["@smos/contracts", "@smos/db", "@smos/telemetry"] };
export default config;
```

`apps/web/src/app/layout.tsx` — placeholder có chủ đích cho P0; P3 thay bằng shell thật:
```tsx
export const metadata = { title: "Solo Marketing OS" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
```

`apps/web/src/app/page.tsx`:
```tsx
export default function Page() {
  return <main>Solo Marketing OS</main>;
}
```

`apps/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "preserve", "lib": ["ES2023", "DOM", "DOM.Iterable"], "noEmit": true, "composite": false, "plugins": [{ "name": "next" }] },
  "include": ["src/**/*.ts", "src/**/*.tsx", "instrumentation.ts", "next.config.ts", ".next/types/**/*.ts"]
}
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run apps/web/src/lib/health.test.ts`
Expected: PASS — 3 test.

- [ ] **Step 5: Xác minh endpoint thật trên server đang chạy**

Run:
```bash
docker compose up -d db
npm run dev --workspace @smos/web &
sleep 8
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/api/health
curl -s http://127.0.0.1:3000/api/health
```
Expected: HTTP **200**; body `{"status":"ok","checks":[{"name":"database","ok":true},{"name":"queue","ok":true}]}`.

Sau đó dừng database và xác minh readiness thật sự phản ứng:
```bash
docker compose stop db
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/api/health
docker compose start db
```
Expected: HTTP **503**. Nếu vẫn 200 thì health check là giả — phải sửa.

- [ ] **Step 6: Commit**

```bash
git add apps/web package.json package-lock.json
git commit -m "feat(web): add next app shell with real readiness health endpoint"
```

---

### Task 10: CI quality gate và scope guard

**Files:**
- Create: `scripts/check-exact-versions.mjs`, `scripts/check-forbidden-scope.mjs`, `scripts/scan-secrets.mjs`, `.github/workflows/ci.yml`
- Test: `scripts/guards.test.mjs`

**Interfaces:**
- Consumes: không
- Produces: `npm run verify` — cổng chất lượng duy nhất mọi commit phải qua

- [ ] **Step 1: Viết failing test**

`scripts/guards.test.mjs`:
```js
import { describe, expect, it } from "vitest";
import { findRangeVersions, findForbiddenDeps, findForbiddenScope } from "./guards.mjs";

describe("findRangeVersions", () => {
  it("flags caret and tilde ranges", () => {
    const found = findRangeVersions({ dependencies: { next: "^16.3.0", zod: "~4.4.3", pg: "8.16.3" } });
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
});

describe("findForbiddenScope", () => {
  it("flags out-of-scope route names", () => {
    expect(findForbiddenScope(["apps/web/src/app/billing/page.tsx"])).toContain("apps/web/src/app/billing/page.tsx");
  });
  it("allows docs that merely mention the words", () => {
    expect(findForbiddenScope(["docs/adr/ADR-007-tenant-isolation-and-rls.md"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx vitest run scripts/guards.test.mjs`
Expected: FAIL — không resolve được `./guards.mjs`.

- [ ] **Step 3: Viết implementation tối thiểu**

`scripts/guards.mjs`:
```js
const FORBIDDEN_DEPS = ["prisma", "@prisma/client", "n8n", "dify", "autogen", "inngest", "@temporalio/client", "@temporalio/worker", "ioredis", "redis", "bullmq"];
const FORBIDDEN_PATH = /(^|\/)(billing|subscription|signup|sign-up|provisioning|marketplace|white-label|whitelabel)(\/|\.)/i;

export function findRangeVersions(pkg) {
  const out = [];
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [name, version] of Object.entries(pkg[field] ?? {})) {
      if (typeof version === "string" && /^[\^~]/.test(version)) out.push(`${name}@${version}`);
    }
  }
  return out;
}

export function findForbiddenDeps(pkg) {
  const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  return names.filter((n) => FORBIDDEN_DEPS.includes(n));
}

/** Only source paths are checked. docs/ is exempt: the ADRs discuss these words. */
export function findForbiddenScope(paths) {
  return paths.filter((p) => !p.startsWith("docs/") && FORBIDDEN_PATH.test(p));
}
```

`scripts/check-exact-versions.mjs`:
```js
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { findRangeVersions, findForbiddenDeps } from "./guards.mjs";

const files = globSync(["package.json", "apps/*/package.json", "packages/*/package.json"]);
let failed = false;
for (const file of files) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  for (const hit of findRangeVersions(pkg)) { console.error(`${file}: range version ${hit} (ADR: pin exact)`); failed = true; }
  for (const hit of findForbiddenDeps(pkg)) { console.error(`${file}: forbidden dependency ${hit}`); failed = true; }
}
console.log(failed ? "version guard FAILED" : `version guard ok (${files.length} manifests)`);
process.exit(failed ? 1 : 0);
```

`scripts/check-forbidden-scope.mjs`:
```js
import { execSync } from "node:child_process";
import { findForbiddenScope } from "./guards.mjs";

const tracked = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
const hits = findForbiddenScope(tracked);
for (const hit of hits) console.error(`out-of-scope path for M0/M1 (D1.b): ${hit}`);
console.log(hits.length ? "scope guard FAILED" : `scope guard ok (${tracked.length} files)`);
process.exit(hits.length ? 1 : 0);
```

`scripts/scan-secrets.mjs` — E10:
```js
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/, /ghp_[A-Za-z0-9]{20,}/, /xox[baprs]-/, /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/, /EAA[A-Za-z0-9]{40,}/, /[0-9]{9,10}:AA[A-Za-z0-9_-]{33}/,
];
const TEXT = /\.(ts|tsx|js|mjs|json|md|yml|yaml|sql|html|css)$/;

const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter((f) => f && TEXT.test(f));
let failed = false;
for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const pattern of PATTERNS) {
    const match = pattern.exec(content);
    if (match) { console.error(`${file}: possible secret matching ${pattern}`); failed = true; }
  }
}
console.log(failed ? "secret scan FAILED" : `secret scan ok (${files.length} files)`);
process.exit(failed ? 1 : 0);
```

`.github/workflows/ci.yml`:
```yaml
name: CI
on: [push, pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      db:
        image: pgvector/pgvector:pg17
        env: { POSTGRES_USER: smos, POSTGRES_PASSWORD: smos_local_dev, POSTGRES_DB: smos }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U smos -d smos"
          --health-interval 5s --health-timeout 5s --health-retries 20
    env:
      DATABASE_URL: postgres://smos:smos_local_dev@127.0.0.1:5432/smos
      NODE_ENV: test
      OTEL_SERVICE_NAME: smos-ci
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: ".nvmrc", cache: npm }
      - run: npm ci
      - run: psql "$DATABASE_URL" -f infra/migrations/0000_init_extensions.sql
      - run: npm run verify
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx vitest run scripts/guards.test.mjs`
Expected: PASS — 5 test.

- [ ] **Step 5: Chạy toàn bộ cổng verify**

Run: `npm run verify`
Expected: bốn dòng `... ok`, typecheck 0 lỗi, toàn bộ test pass, exit code **0**.

Xác minh guard thật sự bắt lỗi — cố tình phá rồi hoàn tác:
```bash
node -e "const f='packages/queue/package.json';const p=JSON.parse(require('fs').readFileSync(f));p.dependencies['pg-boss']='^12.27.0';require('fs').writeFileSync(f,JSON.stringify(p,null,2))"
npm run lint:versions   # Expected: FAILED, exit 1
git checkout packages/queue/package.json
npm run lint:versions   # Expected: ok, exit 0
```

- [ ] **Step 6: Commit**

```bash
git add scripts .github package.json
git commit -m "ci: add version, scope and secret guards to the verify gate"
```

---

## Acceptance Criteria

| # | Tiêu chí | Cách chứng minh |
|---|---|---|
| A1 | `npm run verify` exit 0 | Task 10 Step 5 |
| A2 | PostgreSQL 17 + `vector` + `pgcrypto` chạy | Task 5 Step 4, Task 6 Step 4 |
| A3 | pg-boss round-trip job qua Postgres, không Redis | Task 7 Step 4 |
| A4 | Health endpoint trả **503 thật** khi DB tắt | Task 9 Step 5 |
| A5 | OTel khởi tạo ở cả web và worker | Task 8 Step 4, Task 9 Step 5 |
| A6 | Mọi dependency pin exact | Task 10 Step 5 (guard bắt được lỗi cố ý) |
| A7 | Không dependency cấm | `npm run lint:versions` |
| A8 | Không path D1.b | `npm run lint:scope` |
| A9 | Không secret trong repo | `npm run lint:secrets` |

## Security Checks

- **T4 secret leakage**: `redact()` có test cho connection string, key nhạy cảm và circular ref. `parseServerEnv` không bao giờ đưa giá trị nhận được vào message lỗi. Health endpoint redact error. `scan-secrets.mjs` chạy trong `verify`.
- Không secret nào nằm trong source; `.env` bị ignore, chỉ `.env.example` được commit và chứa mật khẩu **local dev** rõ ràng là giả.

## Tenancy Checks

**P0 chưa có bảng nào thuộc workspace**, nên chưa có tenant check nào chạy được. Đây là điều đúng — P1 sở hữu toàn bộ D1-1…D1-7. P0 chỉ đảm bảo **không tạo ra bảng nào mà không có `workspace_id`**: `packages/db/src/schema/index.ts` cố ý rỗng.

## Audit Evidence

Chưa có `audit_log` ở P0 (thuộc P1). P0 chỉ tạo tiền đề: append-only sẽ cần trigger, và trigger cần migration SQL thuần — đã có `infra/migrations/`.

## Observability Evidence

- `startTelemetry()` chạy trong `apps/worker/src/main.ts` **trước** khi tạo pool và queue.
- `apps/web/instrumentation.ts` dùng hook `register()` của Next, chỉ chạy trên runtime `nodejs`.
- Logger xuất JSON một dòng, có `level`, `msg`, `time`, và không cho field của caller ghi đè key dành riêng.

## Rollback / Recovery

- Mỗi task là một commit độc lập. Rollback = `git revert <sha>`.
- Database local: `docker compose down -v` xoá sạch volume, chạy lại Task 5 Step 4 để dựng lại. Không có dữ liệu thật nên xoá là an toàn.
- Chưa có migration schema nào ngoài extension, nên chưa cần chiến lược rollback migration. P1 sẽ đưa ra.

## Non-Goals

Không entity domain · không auth · không agent · không UI nghiệp vụ · không adapter · không RLS (P1) · không audit log (P1) · không billing/signup/provisioning/marketplace/white-label (D1.b, vĩnh viễn ngoài M0/M1).

## Manual Verification

1. `docker compose up -d db` rồi `npm run dev --workspace @smos/web`.
2. Mở `http://127.0.0.1:3000/api/health` → JSON `status: "ok"`.
3. `docker compose stop db` → tải lại → HTTP 503, `status: "degraded"`, check `database` có `ok: false`.
4. `docker compose start db` → tải lại → 200.
5. `node --experimental-strip-types apps/worker/src/main.ts` → thấy log `{"level":"info","msg":"worker started",...}`; `Ctrl+C` → thấy `worker stopped`.

## Browser Verification

Chưa áp dụng — P0 chưa có UI nghiệp vụ. Trang `/` chỉ là placeholder, P3 thay thế. Browser verification bắt đầu ở P3 và hoàn tất ở P4.

## Evidence Tiers

| Tier | Có ở P0 |
|---|---|
| **Source check** | ✅ Version, license, path guard chạy trong `verify` |
| **Local runtime** | ✅ Postgres thật, pg-boss thật, health 200/503 thật, worker start/stop thật |
| **Sandbox integration** | ❌ Chưa có adapter nào — thuộc P4 |
| **Production verification** | ❌ **Chưa có, và sẽ không có ở M0/M1.** Không được tuyên bố production-ready |
