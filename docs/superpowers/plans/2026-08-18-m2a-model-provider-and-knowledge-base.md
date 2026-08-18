# M2A — model provider and knowledge base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the model gateway a real Anthropic provider that computes its
own cost honestly, and build the knowledge-ingestion pipeline (NFC
normalisation, chunking, embedding, pgvector storage, tier-filtered
retrieval) that M2C's advisory agent will ground its answers in.

**Architecture:** Task 1 is independent of the rest — a `ModelProvider`
implementation behind an injectable-`fetch` seam, dropped into the existing
`packages/model-gateway`. Tasks 2–4 build three small, pure(ish) TypeScript
modules in a new `packages/knowledge` package with no framework — NFC
normalise, then chunk, then embed (real interface + deterministic fake).
Task 5 adds the two pgvector tables migration 0039 introduces, proved safe
against real PostgreSQL as `smos_app`. Task 6 wires `retrieve()` on top of
those tables, with the tier filter proved to be a security control, not a
convenience, against the real database.

**Tech Stack:** Node 24.14.0 / TypeScript 7.0.2 ESM, `pg` 8.23.0 (already
pinned elsewhere in the monorepo), pgvector (already enabled by
`0000_init_extensions.sql`), Vitest. Zero new npm packages — Task 1 talks to
the Anthropic Messages API over the platform's `fetch`, not the SDK; Tasks
2–4 and 6 use nothing beyond the standard library and `pg`.

**Spec:** `docs/superpowers/specs/2026-08-18-customer-advisory-agent-design.md`
(sections 2 — D6, D7 — and 4.1, 4.3). Dependency audit:
`docs/research/2026-08-18-conversational-agent-dependency-audit.md`.

## Global Constraints

Copied verbatim from `docs/superpowers/plans/2026-08-18-m2-plan-index.md` —
binding on every task below.

- Node 24.14.0, npm 11.9.0, TypeScript 7.0.2, ESM only. Relative imports end
  in `.ts` with `rewriteRelativeImportExtensions`; writing `.js` breaks
  Turbopack and Node type-stripping and is caught by `npm run lint:imports`.
- Every dependency pinned to an exact version, no range prefix. Enforced by
  `npm run lint:versions`.
- **Only two new dependencies are permitted across all of M2:**
  `compwright/x-hub-signature` and `promptfoo`. Any third requires stopping
  and asking. The audit doc explains why. (Neither is used by this plan —
  see Task 1 and Task 6 for why the packages already listed in
  `packages/model-gateway/package.json`, and the internal `@smos/db`/`pg`
  reuse in Task 6, do not count against this cap.)
- PostgreSQL 17 + pgvector on host port **5433**. The app connects as
  `smos_app` (NOSUPERUSER, NOBYPASSRLS). Migrations run as `smos`.
- Migrations 0000–0038 are applied. M2 migrations start at **0039**. Never
  edit an applied migration.
- Every workspace-owned table: `workspace_id`, RLS **enabled and forced**,
  policies carrying **both** USING and WITH CHECK. Every foreign key between
  two workspace-owned tables is **composite on `(id, workspace_id)`** with a
  matching UNIQUE on the referenced side — PostgreSQL evaluates foreign keys
  with RLS bypassed on the referenced table.
- Text columns that must carry content use a `~ '\S'` CHECK, never a length
  check. Functions schema-qualify their tables; `SET search_path = public`
  does not exclude `pg_temp`.
- No secret, credential, token or environment value in a migration or a test
  fixture. `npm run lint:secrets` enforces house rules.
- **No paid model call in any test or in CI, ever.** Tests use the
  deterministic fake provider. Embedding calls in tests use a fake embedder.
- TDD is verified, not assumed: write the failing test, run it, paste the
  failing output into the task report, then implement.
- Database invariants are proved against the real PostgreSQL by attempting
  the attack as `smos_app`. Never mock RLS, triggers, constraints,
  transactions or permissions.
- Ids come from `newId()`, never fixed literals — fixed workspace ids have
  already caused a real cross-file collision here. Clean up rows in a way
  that survives a failing test.
- `npm run verify` must exit 0 before every commit, run in the
  **foreground**.
- Commit style: lowercase conventional prefix, no emoji, body ending
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

**Interface contract binding this plan** (copied from the index; do not
diverge from these exact signatures):

```ts
// M2A — packages/model-gateway/src/anthropic.ts
export interface AnthropicProviderConfig {
  apiKey: string;
  model: string;              // e.g. "claude-opus-5"
  maxOutputTokens: number;    // hard per-call ceiling
  inputUsdPerMTok: number;    // priced by the caller, not guessed by the provider
  outputUsdPerMTok: number;
}
export function createAnthropicProvider(cfg: AnthropicProviderConfig): ModelProvider;

// M2A — packages/knowledge/src/normalise.ts
export function normaliseVietnamese(text: string): string;   // NFC + whitespace collapse

// M2A — packages/knowledge/src/chunk.ts
export interface Chunk { text: string; ordinal: number; }
export function chunkDocument(text: string, maxChars: number): Chunk[];

// M2A — packages/knowledge/src/embed.ts
export interface Embedder { readonly name: string; readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>; }
export function createFakeEmbedder(dimensions: number): Embedder;

// M2A — packages/knowledge/src/retrieve.ts
export type KnowledgeTier = "t1_authoritative" | "t2_reference" | "t3_hint" | "t4_voice";
export interface RetrievedChunk {
  chunkId: Id; documentId: Id; tier: KnowledgeTier; text: string; distance: number;
}
export function retrieve(pool: pg.Pool, workspaceId: Id, input: {
  queryEmbedding: number[]; tiers: KnowledgeTier[]; limit: number;
}): Promise<RetrievedChunk[]>;
```

**Deliberate, precedented extension to `createAnthropicProvider` — disclosed
here, not silently done in Task 1.** The fixed signature above,
`createAnthropicProvider(cfg): ModelProvider`, is exactly what this plan
implements as the one-argument call. Task 1 adds a second, **optional**
parameter, `fetchImpl: FetchLike = fetch`, so a test can inject a fake HTTP
response instead of calling the real Anthropic API (Global Constraint: "No
paid model call in any test, ever"). This is not a new interface shape —
`createAnthropicProvider(cfg)` still type-checks, resolves to the same
`ModelProvider`, and behaves identically to a caller who never heard of the
second parameter. It is the exact pattern this codebase already uses for
every other outbound HTTP client: `guardedFetch(url, allowedHosts, init,
fetchImpl = fetch)` and `createMetaAdapter(cfg, fetchImpl = fetch)` in
`packages/integrations/src/guarded-fetch.ts` and
`packages/integrations/src/meta/client.ts`. Without this seam, Task 1's
required test ("plan an injected fetch so the test drives a fake HTTP
response") is not satisfiable without diverging from the fixed signature in
a worse way (e.g. a `baseUrl` override, which the task did not ask for and
which does not stop the test from constructing a real `Request`/`fetch`
call path).

---

### Task 1: A real Anthropic model provider

**Files:**
- Create: `packages/model-gateway/src/anthropic.ts`
- Create: `packages/model-gateway/src/anthropic.test.ts`
- Modify: `packages/model-gateway/src/index.ts`

**Interfaces:**
- Consumes: `GenerateRequest`, `GenerateResult`, `ModelProvider` from
  `packages/model-gateway/src/types.ts` (`{ system, input, schemaName,
  maxOutputTokens }` in; `{ text, tokensIn, tokensOut, costUsd, modelVersion
  }` out).
- Produces: `AnthropicProviderConfig`, `createAnthropicProvider(cfg,
  fetchImpl?)`, exported from `packages/model-gateway/src/index.ts` for
  every later M2 task (and the separately-planned $5 canary) to import as
  `@smos/model-gateway`.

Read `packages/model-gateway/src/gateway.ts` lines 150–360 before writing
this file (already read while researching this plan): `estimatedCostUsd` is
the caller's declared **maximum**, validated and enforced by the gateway;
`result.costUsd > deps.estimatedCostUsd` is treated as a **contract
violation** by the caller, not routine variance. This task's job is only to
make `costUsd` true — an honest function of the tokens Anthropic actually
billed, times the prices the caller configured. Getting that arithmetic
wrong is a money bug, not a test failure.

- [ ] **Step 1: Write the failing test**

```ts
// packages/model-gateway/src/anthropic.test.ts
import { describe, expect, it } from "vitest";
import { createAnthropicProvider, type AnthropicProviderConfig, type FetchLike } from "./anthropic.ts";

const cfg: AnthropicProviderConfig = {
  apiKey: "fake-api-key-not-real",
  model: "claude-opus-5",
  maxOutputTokens: 1000,
  inputUsdPerMTok: 3,
  outputUsdPerMTok: 15,
};

function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

describe("createAnthropicProvider", () => {
  it("computes costUsd from the real token usage times the configured per-MTok prices", async () => {
    const { fetchImpl } = fakeFetch({
      content: [{ type: "text", text: "Xin chao!" }],
      model: "claude-opus-5-20260101",
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    const provider = createAnthropicProvider(cfg, fetchImpl);

    const result = await provider.generate({
      system: "You are a helpful assistant.",
      input: "Xin chao",
      schemaName: "greeting",
      maxOutputTokens: 500,
    });

    expect(result.tokensIn).toBe(1000);
    expect(result.tokensOut).toBe(500);
    // (1000 * 3 + 500 * 15) / 1_000_000
    expect(result.costUsd).toBeCloseTo(0.0105, 10);
    expect(result.text).toBe("Xin chao!");
    expect(result.modelVersion).toBe("claude-opus-5-20260101");
  });

  it("never touches the real network -- the injected fetch is the only HTTP path exercised", async () => {
    const { fetchImpl, calls } = fakeFetch({
      content: [{ type: "text", text: "ok" }],
      model: "claude-opus-5",
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const provider = createAnthropicProvider(cfg, fetchImpl);
    await provider.generate({ system: "s", input: "i", schemaName: "x", maxOutputTokens: 100 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("honours the caller's maxOutputTokens when it is below the configured ceiling", async () => {
    const { fetchImpl, calls } = fakeFetch({
      content: [{ type: "text", text: "ok" }],
      model: "claude-opus-5",
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    const provider = createAnthropicProvider(cfg, fetchImpl);
    await provider.generate({ system: "s", input: "i", schemaName: "x", maxOutputTokens: 200 });
    const sentBody = JSON.parse(calls[0]!.init!.body as string);
    expect(sentBody.max_tokens).toBe(200);
  });

  it("clamps to the configured maxOutputTokens ceiling when the caller asks for more", async () => {
    const { fetchImpl, calls } = fakeFetch({
      content: [{ type: "text", text: "ok" }],
      model: "claude-opus-5",
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    const provider = createAnthropicProvider(cfg, fetchImpl); // cfg.maxOutputTokens = 1000
    await provider.generate({ system: "s", input: "i", schemaName: "x", maxOutputTokens: 5000 });
    const sentBody = JSON.parse(calls[0]!.init!.body as string);
    expect(sentBody.max_tokens).toBe(1000);
  });

  it("throws instead of fabricating a cost when the response carries no usable usage", async () => {
    const { fetchImpl } = fakeFetch({
      content: [{ type: "text", text: "ok" }],
      model: "claude-opus-5",
      usage: {},
    });
    const provider = createAnthropicProvider(cfg, fetchImpl);
    await expect(
      provider.generate({ system: "s", input: "i", schemaName: "x", maxOutputTokens: 100 }),
    ).rejects.toThrow(/usage/);
  });

  it("throws a descriptive error on a non-2xx response instead of returning a fake result", async () => {
    const { fetchImpl } = fakeFetch(
      { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
      401,
    );
    const provider = createAnthropicProvider(cfg, fetchImpl);
    await expect(
      provider.generate({ system: "s", input: "i", schemaName: "x", maxOutputTokens: 100 }),
    ).rejects.toThrow(/invalid x-api-key/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/model-gateway/src/anthropic.test.ts`
Expected: FAIL — `Cannot find module './anthropic.ts'` (or equivalent
"failed to resolve import" from Vitest/esbuild), because `anthropic.ts`
does not exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// packages/model-gateway/src/anthropic.ts
import type { GenerateRequest, GenerateResult, ModelProvider } from "./types.ts";

export interface AnthropicProviderConfig {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

/** The subset of `fetch`'s signature this module depends on -- narrow on
 * purpose so a test's fake fetch doesn't need to implement anything beyond
 * what is actually used. Mirrors
 * packages/integrations/src/guarded-fetch.ts's FetchLike, redeclared here
 * (not imported) so packages/model-gateway does not take a dependency on
 * packages/integrations for one type alias. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Computes costUsd itself from the token counts the API actually billed,
 * times the caller-configured per-MTok prices -- never guessed, never a
 * flat per-call estimate. gateway.ts trusts this number outright to
 * enforce its budget (see that file's header on estimatedCostUsd being a
 * declared per-call MAXIMUM): a wrong computation here is a money bug.
 */
function computeCostUsd(tokensIn: number, tokensOut: number, cfg: AnthropicProviderConfig): number {
  return (tokensIn * cfg.inputUsdPerMTok + tokensOut * cfg.outputUsdPerMTok) / 1_000_000;
}

function extractErrorMessage(parsed: unknown, status: number): string {
  if (
    parsed &&
    typeof parsed === "object" &&
    "error" in parsed &&
    parsed.error &&
    typeof (parsed as { error: { message?: unknown } }).error.message === "string"
  ) {
    return (parsed as { error: { message: string } }).error.message;
  }
  return `HTTP ${status}`;
}

/**
 * `fetchImpl` defaults to the real global `fetch`, exactly like
 * `guardedFetch` and `createMetaAdapter` elsewhere in this codebase -- it
 * exists purely so a test can swap in a fake HTTP response, never so a
 * real caller has to think about it. Every test for this provider drives
 * it through a fake fetchImpl that never opens a socket (Global Constraint:
 * no paid model call in any test, ever).
 */
export function createAnthropicProvider(cfg: AnthropicProviderConfig, fetchImpl: FetchLike = fetch): ModelProvider {
  return {
    name: "anthropic",

    async generate(req: GenerateRequest): Promise<GenerateResult> {
      // maxOutputTokens on the config is a hard per-call ceiling (interface
      // contract): a caller may ask for less, never more.
      const maxTokens = Math.min(req.maxOutputTokens, cfg.maxOutputTokens);

      const response = await fetchImpl(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "x-api-key": cfg.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: maxTokens,
          system: req.system,
          messages: [{ role: "user", content: req.input }],
        }),
      });

      const bodyText = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        throw new Error(
          `Anthropic provider "${cfg.model}": non-JSON response (status ${response.status}): ${bodyText.slice(0, 200)}`,
        );
      }

      if (!response.ok) {
        throw new Error(`Anthropic provider "${cfg.model}" request failed: ${extractErrorMessage(parsed, response.status)}`);
      }

      const data = parsed as AnthropicMessagesResponse;
      const tokensIn = data.usage?.input_tokens;
      const tokensOut = data.usage?.output_tokens;

      // A hostile or buggy upstream must not be able to make this provider
      // invent a cost: if the token counts we would multiply by price are
      // not real, finite numbers, refuse outright rather than returning
      // costUsd: 0 or NaN (gateway.ts's isRecordableCost would otherwise
      // silently record nothing for real money spent, or corrupt the
      // running total).
      if (!Number.isFinite(tokensIn) || !Number.isFinite(tokensOut)) {
        throw new Error(
          `Anthropic provider "${cfg.model}": response carried no usable token usage -- refusing to invent a cost. Got usage: ${JSON.stringify(data.usage)}`,
        );
      }

      const text = (data.content ?? [])
        .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");

      return {
        text,
        tokensIn: tokensIn as number,
        tokensOut: tokensOut as number,
        costUsd: computeCostUsd(tokensIn as number, tokensOut as number, cfg),
        modelVersion: data.model ?? cfg.model,
      };
    },
  };
}
```

Then update the barrel export:

```ts
// packages/model-gateway/src/index.ts (add these two lines)
export { createAnthropicProvider, type AnthropicProviderConfig, type FetchLike } from "./anthropic.ts";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/model-gateway/src/anthropic.test.ts`
Expected: PASS — 6 tests green.

- [ ] **Step 5: Run verify and commit**

Run: `npm run verify`
Expected: exits 0.

```bash
git add packages/model-gateway/src/anthropic.ts packages/model-gateway/src/anthropic.test.ts packages/model-gateway/src/index.ts
git commit -m "$(cat <<'EOF'
feat(model-gateway): add real anthropic model provider

Computes costUsd itself from the tokens Anthropic actually billed times
the caller-configured per-MTok prices, honours maxOutputTokens as a hard
ceiling, and is driven entirely by an injected fetch in tests so no test
ever calls the paid API. Unblocks the $5 canary and every later M2C call.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Unicode NFC normalisation (`normaliseVietnamese`)

**Files:**
- Create: `packages/knowledge/package.json`
- Create: `packages/knowledge/tsconfig.json`
- Create: `packages/knowledge/src/index.ts`
- Create: `packages/knowledge/src/normalise.ts`
- Create: `packages/knowledge/src/normalise.test.ts`
- Modify: `tsconfig.json` (root)

**Interfaces:**
- Consumes: nothing (pure function of a string).
- Produces: `normaliseVietnamese(text: string): string`, exported from
  `packages/knowledge/src/index.ts` as `@smos/knowledge` for Task 3's
  ingestion callers and, later, M2C's query path — every string that is
  chunked, embedded, or used as a retrieval query must go through this
  first (D6).

This task also creates the `@smos/knowledge` package skeleton (empty of
runtime dependencies, matching `packages/policy/package.json`'s pattern —
Tasks 3, 4 and 6 add exactly the dependency each of their own files needs,
not upfront).

- [ ] **Step 1: Create the package skeleton**

```json
// packages/knowledge/package.json
{
  "name": "@smos/knowledge",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

```json
// packages/knowledge/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

```ts
// packages/knowledge/src/index.ts
export { normaliseVietnamese } from "./normalise.ts";
```

Add `packages/knowledge` to the root project references so `npm run
typecheck` (`tsc --build`) picks it up:

```json
// tsconfig.json (root) -- add this entry to "references"
    { "path": "./packages/knowledge" },
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/knowledge/src/normalise.test.ts
import { describe, expect, it } from "vitest";
import { normaliseVietnamese } from "./normalise.ts";

describe("normaliseVietnamese", () => {
  it("normalises decomposed and composed forms of the same Vietnamese word to the identical byte sequence", () => {
    const composed = "Tiếng Việt"; // NFC -- as a Vietnamese keyboard/IME produces it
    const decomposed = composed.normalize("NFD"); // base letters + combining diacritical marks
    expect(decomposed).not.toBe(composed); // sanity: these really are two different byte sequences
    expect(normaliseVietnamese(decomposed)).toBe(normaliseVietnamese(composed));
    expect(normaliseVietnamese(decomposed)).toBe("Tiếng Việt");
  });

  it("collapses runs of internal and surrounding whitespace", () => {
    expect(normaliseVietnamese("  Xin   chào   thế giới  ")).toBe("Xin chào thế giới");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/knowledge/src/normalise.test.ts`
Expected: FAIL — `Cannot find module './normalise.ts'`, because the file
does not exist yet.

- [ ] **Step 4: Write the implementation**

```ts
// packages/knowledge/src/normalise.ts

/**
 * D6: the same Vietnamese string exists in composed (NFC) and decomposed
 * (NFD) Unicode byte forms -- a diacritic can be one precomposed code point
 * or a base letter followed by combining marks. Skipping normalisation
 * before chunking, embedding or querying makes identical text retrieve
 * differently, silently and with no error, because the two byte forms hash
 * and embed differently even though a human reads them as the same word.
 * NFC is chosen (not NFD) because it is what a Vietnamese keyboard/IME
 * actually produces and what most stored text already is.
 */
export function normaliseVietnamese(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/knowledge/src/normalise.test.ts`
Expected: PASS — 2 tests green.

- [ ] **Step 6: Run verify and commit**

Run: `npm run verify`
Expected: exits 0.

```bash
git add packages/knowledge/package.json packages/knowledge/tsconfig.json packages/knowledge/src/index.ts packages/knowledge/src/normalise.ts packages/knowledge/src/normalise.test.ts tsconfig.json
git commit -m "$(cat <<'EOF'
feat(knowledge): add unicode NFC normalisation for vietnamese text

D6: composed and decomposed forms of the same Vietnamese word must
normalise to identical bytes before chunking, embedding or querying, or
identical text retrieves differently with no error. Also creates the
@smos/knowledge package.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Chunking (`chunkDocument`)

**Files:**
- Create: `packages/knowledge/src/chunk.ts`
- Create: `packages/knowledge/src/chunk.test.ts`
- Modify: `packages/knowledge/src/index.ts`

**Interfaces:**
- Consumes: nothing new. Callers are expected to pass text already through
  `normaliseVietnamese` (Task 2) — `chunkDocument` itself does not
  normalise, keeping each file to one responsibility.
- Produces: `interface Chunk { text: string; ordinal: number; }` and
  `chunkDocument(text: string, maxChars: number): Chunk[]`, exported from
  `packages/knowledge/src/index.ts` for Task 6's ingestion path (and later
  M2's ingestion UI) to call before embedding.

- [ ] **Step 1: Write the failing test**

```ts
// packages/knowledge/src/chunk.test.ts
import { describe, expect, it } from "vitest";
import { chunkDocument } from "./chunk.ts";

describe("chunkDocument", () => {
  it("returns a single chunk when the whole text fits within maxChars", () => {
    expect(chunkDocument("Xin chao the gioi", 100)).toEqual([{ text: "Xin chao the gioi", ordinal: 0 }]);
  });

  it("splits long text into multiple chunks, each within maxChars and ordinal-ordered, with no word lost", () => {
    const words = Array.from({ length: 20 }, (_, i) => `tu${i}`);
    const text = words.join(" ");
    const chunks = chunkDocument(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => {
      expect(c.ordinal).toBe(i);
      expect(c.text.length).toBeLessThanOrEqual(30);
    });
    expect(chunks.flatMap((c) => c.text.split(" "))).toEqual(words);
  });

  it("hard-splits a single token longer than maxChars into fixed-size pieces", () => {
    const longWord = "a".repeat(75);
    const chunks = chunkDocument(longWord, 30);
    expect(chunks).toEqual([
      { text: "a".repeat(30), ordinal: 0 },
      { text: "a".repeat(30), ordinal: 1 },
      { text: "a".repeat(15), ordinal: 2 },
    ]);
  });

  it("returns an empty array for blank or whitespace-only input", () => {
    expect(chunkDocument("   \n\t  ", 100)).toEqual([]);
    expect(chunkDocument("", 100)).toEqual([]);
  });

  it("throws when maxChars is not a positive number", () => {
    expect(() => chunkDocument("hello", 0)).toThrow(/maxChars/);
    expect(() => chunkDocument("hello", -5)).toThrow(/maxChars/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/knowledge/src/chunk.test.ts`
Expected: FAIL — `Cannot find module './chunk.ts'`, because the file does
not exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// packages/knowledge/src/chunk.ts

export interface Chunk {
  text: string;
  ordinal: number;
}

/**
 * Greedy word-fill chunking, ~40 lines total for the whole module -- the
 * dependency audit's argument against a framework here is that ~300 lines
 * of hand-written code covers retrieve -> prompt -> generate end to end, so
 * this stays deliberately simple. Words are never split unless a single
 * word alone exceeds maxChars, in which case it is hard-split into
 * maxChars-sized pieces so no chunk ever exceeds the caller's limit.
 */
export function chunkDocument(text: string, maxChars: number): Chunk[] {
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    throw new Error(`chunkDocument requires maxChars to be a finite number > 0, got ${maxChars}`);
  }

  const trimmed = text.trim();
  if (trimmed === "") return [];

  const words = trimmed.split(/\s+/);
  const chunks: Chunk[] = [];
  let current = "";

  function pushCurrent(): void {
    if (current.length > 0) {
      chunks.push({ text: current, ordinal: chunks.length });
      current = "";
    }
  }

  for (const word of words) {
    if (word.length > maxChars) {
      pushCurrent();
      for (let i = 0; i < word.length; i += maxChars) {
        chunks.push({ text: word.slice(i, i + maxChars), ordinal: chunks.length });
      }
      continue;
    }
    const candidate = current === "" ? word : `${current} ${word}`;
    if (candidate.length > maxChars) {
      pushCurrent();
      current = word;
    } else {
      current = candidate;
    }
  }
  pushCurrent();

  return chunks;
}
```

```ts
// packages/knowledge/src/index.ts (add this line)
export { type Chunk, chunkDocument } from "./chunk.ts";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/knowledge/src/chunk.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Run verify and commit**

Run: `npm run verify`
Expected: exits 0.

```bash
git add packages/knowledge/src/chunk.ts packages/knowledge/src/chunk.test.ts packages/knowledge/src/index.ts
git commit -m "$(cat <<'EOF'
feat(knowledge): add chunkDocument

Greedy word-fill chunking that never exceeds maxChars per chunk and never
drops a word, with ordinal numbering for stable ordering downstream.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The `Embedder` interface plus a deterministic fake embedder

**Files:**
- Create: `packages/knowledge/src/embed.ts`
- Create: `packages/knowledge/src/embed.test.ts`
- Modify: `packages/knowledge/src/index.ts`

**Interfaces:**
- Consumes: nothing (the fake is a pure function of its input texts).
- Produces: `interface Embedder { readonly name: string; readonly
  dimensions: number; embed(texts: string[]): Promise<number[][]>; }` and
  `createFakeEmbedder(dimensions: number): Embedder`, exported from
  `packages/knowledge/src/index.ts`. Task 6's tests use this exclusively —
  Global Constraint: "Embedding calls in tests use a fake embedder." A real
  embedder (calling an external embedding API) is out of scope for M2A and
  is not implemented here; only the interface and the fake are.

- [ ] **Step 1: Write the failing test**

```ts
// packages/knowledge/src/embed.test.ts
import { describe, expect, it } from "vitest";
import { createFakeEmbedder } from "./embed.ts";

describe("createFakeEmbedder", () => {
  it("returns vectors of the configured dimensionality", async () => {
    const embedder = createFakeEmbedder(8);
    const [vector] = await embedder.embed(["san pham demo"]);
    expect(vector).toHaveLength(8);
    expect(embedder.dimensions).toBe(8);
    expect(embedder.name).toBe("fake");
  });

  it("is deterministic: the same text embeds to the identical vector every time", async () => {
    const embedder = createFakeEmbedder(16);
    const [first] = await embedder.embed(["gia san pham la bao nhieu"]);
    const [second] = await embedder.embed(["gia san pham la bao nhieu"]);
    expect(second).toEqual(first);
  });

  it("embeds different texts to different vectors", async () => {
    const embedder = createFakeEmbedder(16);
    const [a, b] = await embedder.embed(["gia san pham", "chinh sach bao hanh"]);
    expect(a).not.toEqual(b);
  });

  it("embeds a batch in the same order as embedding each text alone", async () => {
    const embedder = createFakeEmbedder(4);
    const texts = ["mot", "hai", "ba"];
    const vectors = await embedder.embed(texts);
    const [single0] = await embedder.embed([texts[0]!]);
    const [single1] = await embedder.embed([texts[1]!]);
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toEqual(single0);
    expect(vectors[1]).toEqual(single1);
  });

  it("throws when dimensions is not a positive number", () => {
    expect(() => createFakeEmbedder(0)).toThrow(/dimensions/);
    expect(() => createFakeEmbedder(-3)).toThrow(/dimensions/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/knowledge/src/embed.test.ts`
Expected: FAIL — `Cannot find module './embed.ts'`, because the file does
not exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// packages/knowledge/src/embed.ts

export interface Embedder {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * FNV-1a, chosen only because it is small, dependency-free, and stable
 * across Node versions -- not for any cryptographic property. Maps a seed
 * string to a value in [-1, 1] deterministically: same seed, same output,
 * forever, on any machine.
 */
function hashToUnit(seed: string): number {
  let h = 2166136261 >>> 0; // FNV-1a offset basis
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h / 0xffffffff) * 2 - 1;
}

/**
 * Deterministic by construction: reads no clock, generates no random
 * numbers, makes no network call. Every M2A/M2C test that needs an
 * embedding runs against this so that no test or CI run ever calls a paid
 * embedding API (Global Constraint: "Embedding calls in tests use a fake
 * embedder"), mirroring packages/model-gateway/src/fake.ts's own header for
 * the same reason on the model-provider side.
 */
export function createFakeEmbedder(dimensions: number): Embedder {
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    throw new Error(`createFakeEmbedder requires dimensions to be a finite number > 0, got ${dimensions}`);
  }
  return {
    name: "fake",
    dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => Array.from({ length: dimensions }, (_, i) => hashToUnit(`${text}:${i}`)));
    },
  };
}
```

```ts
// packages/knowledge/src/index.ts (add this line)
export { type Embedder, createFakeEmbedder } from "./embed.ts";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/knowledge/src/embed.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Run verify and commit**

Run: `npm run verify`
Expected: exits 0.

```bash
git add packages/knowledge/src/embed.ts packages/knowledge/src/embed.test.ts packages/knowledge/src/index.ts
git commit -m "$(cat <<'EOF'
feat(knowledge): add Embedder interface and a deterministic fake embedder

The fake is a pure function of its input texts (FNV-1a hashed into
[-1, 1] per dimension) -- no clock, no RNG, no network call, so every
test that needs an embedding can run without a paid embedding API.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Migration 0039 — `knowledge_document` and `knowledge_chunk`

**Files:**
- Create: `infra/migrations/0039_knowledge_base.sql`
- Create: `packages/db/src/knowledge-tenant.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `TenantTx` from `packages/db/src/tenant-scope.ts`;
  `createDb`, `createDbPool` from `packages/db/src/client.ts`; `newId` from
  `@smos/domain`.
- Produces: the `knowledge_document` and `knowledge_chunk` tables Task 6's
  `retrieve()` queries, and the `vector(1024)` column M2A's future
  embedding-write path inserts into. No TypeScript symbols — this task is
  schema only, proved by an integration test against real PostgreSQL.

This is the one task in this plan where the test genuinely cannot pass
before the implementation exists — you cannot query a table PostgreSQL
doesn't have yet. The TDD cycle here is: write the test against the schema
this task is about to create, run it and watch it fail with a real
"relation does not exist" error (proving the test is actually hitting
Postgres, not silently no-op'ing), write the migration, apply it, then
watch the same test pass.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/src/knowledge-tenant.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { newId } from "@smos/domain";
import { createDb, createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const APP_URL = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const MIGRATION_URL = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";

const pool = createDbPool(APP_URL);
const db = createDb(pool);
const migrationPool = createDbPool(MIGRATION_URL);

const A = newId();
const B = newId();

beforeAll(async () => {
  await db.execute(
    sql`insert into workspace (id, name) values (${A}::uuid, 'knowledge-tenant-A'), (${B}::uuid, 'knowledge-tenant-B')`,
  );
});

afterAll(async () => {
  // Runs even if an assertion above threw -- afterAll always executes in
  // vitest, so cleanup survives a failing test rather than leaking rows
  // only on the happy path. DATABASE_MIGRATION_URL (the smos role) is used
  // because smos_app has no DELETE grant, same as every other integration
  // test in this directory.
  await migrationPool.query("delete from knowledge_chunk where workspace_id = any($1::uuid[])", [[A, B]]);
  await migrationPool.query("delete from knowledge_document where workspace_id = any($1::uuid[])", [[A, B]]);
  await migrationPool.query("delete from workspace where id = any($1::uuid[])", [[A, B]]);
  await migrationPool.end();
  await pool.end();
});

describe("knowledge_document, knowledge_chunk -- row level security", () => {
  it("is enabled and forced on both tables", async () => {
    const r = await db.execute(
      sql`select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('knowledge_document', 'knowledge_chunk')`,
    );
    const rows = r.rows as { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it("rejects a tier outside the four allowed values", async () => {
    await expect(
      withTenant(pool, A, (tx) =>
        tx.query(`insert into knowledge_document (id, workspace_id, tier, title) values ($1, $2, 'not_a_real_tier', 'bad doc')`, [
          newId(),
          A,
        ]),
      ),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("a document and chunk belonging to workspace B are invisible when scoped to workspace A (cross-tenant read)", async () => {
    const docId = newId();
    const chunkId = newId();
    await withTenant(pool, B, async (tx) => {
      await tx.query(
        `insert into knowledge_document (id, workspace_id, tier, title) values ($1, $2, 't1_authoritative', 'B-only doc')`,
        [docId, B],
      );
      await tx.query(
        `insert into knowledge_chunk (id, workspace_id, document_id, ordinal, text) values ($1, $2, $3, 0, 'B-only chunk text')`,
        [chunkId, B, docId],
      );
    });

    const seenFromA = await withTenant(pool, A, (tx) =>
      tx.query("select count(*)::int as n from knowledge_chunk where id = $1", [chunkId]),
    );
    expect(seenFromA.rows[0].n).toBe(0);

    const seenFromB = await withTenant(pool, B, (tx) =>
      tx.query("select count(*)::int as n from knowledge_chunk where id = $1", [chunkId]),
    );
    expect(seenFromB.rows[0].n).toBe(1);
  });

  it("an insert tagged with workspace B is refused while scoped to workspace A (cross-tenant write)", async () => {
    await expect(
      withTenant(pool, A, (tx) =>
        // Session is scoped to A but this row claims workspace B -- the
        // policy's WITH CHECK must reject it outright.
        tx.query(
          `insert into knowledge_document (id, workspace_id, tier, title) values ($1, $2, 't1_authoritative', 'cross-tenant insert')`,
          [newId(), B],
        ),
      ),
    ).rejects.toThrow(/new row violates row-level security policy for table "knowledge_document"/);

    const ownDocId = newId();
    await withTenant(pool, A, (tx) =>
      tx.query(`insert into knowledge_document (id, workspace_id, tier, title) values ($1, $2, 't1_authoritative', 'A doc')`, [
        ownDocId,
        A,
      ]),
    );

    await expect(
      withTenant(pool, A, (tx) =>
        tx.query(
          `insert into knowledge_chunk (id, workspace_id, document_id, ordinal, text) values ($1, $2, $3, 0, 'cross-tenant chunk write')`,
          [newId(), B, ownDocId],
        ),
      ),
    ).rejects.toThrow(/new row violates row-level security policy for table "knowledge_chunk"/);
  });

  it("a chunk cannot be attached to another workspace's document even when correctly tagged with its own workspace_id (composite FK)", async () => {
    // B creates a document. A then tries to attach a chunk to it, tagging
    // the chunk with A's own workspace_id -- which satisfies RLS's WITH
    // CHECK on its own. Only the composite FK (document_id, workspace_id)
    // stands between this and a cross-tenant chunk silently inheriting B's
    // document's tier (the exact attack 0028_integration.sql's own header
    // describes for credential_reference -> integration).
    const bDocId = newId();
    await withTenant(pool, B, (tx) =>
      tx.query(`insert into knowledge_document (id, workspace_id, tier, title) values ($1, $2, 't1_authoritative', 'B doc, forged-FK probe')`, [
        bDocId,
        B,
      ]),
    );

    await expect(
      withTenant(pool, A, (tx) =>
        tx.query(`insert into knowledge_chunk (id, workspace_id, document_id, ordinal, text) values ($1, $2, $3, 0, 'forged FK attempt')`, [
          newId(),
          A,
          bDocId,
        ]),
      ),
    ).rejects.toThrow(/violates foreign key constraint/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/db/src/knowledge-tenant.test.ts`
Expected: FAIL — every test errors with `relation "knowledge_document" does
not exist` (a real PostgreSQL error), because migration 0039 has not been
applied yet.

- [ ] **Step 3: Write the migration**

```sql
-- infra/migrations/0039_knowledge_base.sql
--
-- M2A Task 5: knowledge_document and knowledge_chunk -- the ingested source
-- material the customer-advisory agent (M2C) may ground a reply in, and the
-- provenance tier (D3, docs/superpowers/specs/2026-08-18-customer-advisory-
-- agent-design.md section 2) that bounds what each chunk may be used to
-- assert. pgvector's `vector` extension is already enabled by
-- 0000_init_extensions.sql; this is the first migration to use it.
--
-- Both tables are workspace-owned per ADR-007: workspace_id NOT NULL, RLS
-- ENABLED and FORCED, and a policy carrying both USING and WITH CHECK, in
-- the same pattern as every table since 0001_core_tenancy.sql.
--
-- knowledge_chunk's foreign key to knowledge_document is composite on
-- (id, workspace_id), exactly like 0008_composite_tenant_fk.sql /
-- 0028_integration.sql: PostgreSQL evaluates a foreign key against its
-- referenced table with RLS bypassed entirely, so a plain single-column
-- `REFERENCES knowledge_document(id)` would only prove "some document with
-- this id exists anywhere", never that it belongs to the same workspace as
-- the chunk -- letting a session scoped to workspace B attach a chunk to
-- workspace A's document and silently inherit that document's tier.
-- knowledge_document gets UNIQUE (id, workspace_id) so the child's
-- composite FK has something to target.
--
-- Text CHECKs use `x ~ '\S'`, never a length check
-- (0009_check_whitespace_hardening.sql).

CREATE TABLE IF NOT EXISTS knowledge_document (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  tier         text NOT NULL CHECK (tier IN ('t1_authoritative', 't2_reference', 't3_hint', 't4_voice')),
  title        text NOT NULL CHECK (title ~ '\S'),
  source_uri   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Required so knowledge_chunk's composite FK below can target
  -- (id, workspace_id) -- redundant with the primary key alone already
  -- being unique, but PostgreSQL requires the pair itself to be backed by
  -- a UNIQUE or PRIMARY KEY constraint for a composite FK to reference it.
  UNIQUE (id, workspace_id)
);
ALTER TABLE knowledge_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_document FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_document_tenant_isolation ON knowledge_document;
CREATE POLICY knowledge_document_tenant_isolation ON knowledge_document
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- knowledge_chunk carries embedding vector(1024) -- 1024 dimensions to
-- match the two candidate Vietnamese embedding models named in the
-- dependency audit (AITeamVN/Vietnamese_Embedding, a bge-m3 fine-tune, and
-- BAAI/bge-m3 itself both embed at 1024), not a framework default.
-- `embedding` is nullable: chunk text is written by ingestion (chunk.ts)
-- before the embedding step runs, and this table must be able to hold a
-- chunk in that intermediate state rather than force a single all-or-
-- nothing transaction across chunking and a paid embedding call.
-- `ordinal` is the chunk's position within its document, produced by
-- chunk.ts's ordinal-numbered output.
CREATE TABLE IF NOT EXISTS knowledge_chunk (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  document_id  uuid NOT NULL,
  ordinal      integer NOT NULL CHECK (ordinal >= 0),
  text         text NOT NULL CHECK (text ~ '\S'),
  embedding    vector(1024),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, ordinal),
  FOREIGN KEY (document_id, workspace_id) REFERENCES knowledge_document (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_chunk_ws_document_idx ON knowledge_chunk (workspace_id, document_id);
ALTER TABLE knowledge_chunk ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunk FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_chunk_tenant_isolation ON knowledge_chunk;
CREATE POLICY knowledge_chunk_tenant_isolation ON knowledge_chunk
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- No DELETE grant, matching every other workspace-owned table's runtime
-- grant list (0004_campaign.sql, 0012_agent_registry.sql,
-- 0028_integration.sql): smos_app reads, inserts and updates but never
-- deletes. Test cleanup goes through DATABASE_MIGRATION_URL (the smos
-- role), same as every other integration test in packages/db/src.
GRANT SELECT, INSERT, UPDATE ON knowledge_document, knowledge_chunk TO smos_app;
```

- [ ] **Step 4: Apply the migration**

Run: `npm run db:migrate`
Expected: exits 0, prints that `0039_knowledge_base.sql` was applied.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/db/src/knowledge-tenant.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 6: Run verify and commit**

Run: `npm run verify`
Expected: exits 0 (this also runs `npm run lint:migrations`, which checks
every table here has `workspace_id` and RLS enabled).

```bash
git add infra/migrations/0039_knowledge_base.sql packages/db/src/knowledge-tenant.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add knowledge_document and knowledge_chunk tables (migration 0039)

RLS enabled and forced on both, tier CHECK-constrained to the four
provenance tiers, and knowledge_chunk's foreign key to its document is
composite on (id, workspace_id) so a chunk cannot be attached to another
workspace's document even when correctly tagged with its own
workspace_id. Proved against real PostgreSQL as smos_app: cross-tenant
read, cross-tenant write, and the composite-FK forged-attach attack all
fail.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Tier-filtered retrieval (`retrieve`)

**Files:**
- Modify: `packages/knowledge/package.json` (add `@smos/domain`, `@smos/db`,
  `pg` as dependencies; `@types/pg` as a devDependency — all four are
  already-present, already-pinned packages elsewhere in this monorepo
  (`packages/db/package.json`, `packages/vault/package.json`), so adding
  them as dependencies of the new `@smos/knowledge` package does not widen
  the dependency tree and does not count against M2's two-new-dependency
  cap, which governs genuinely new third-party packages)
- Create: `packages/knowledge/src/retrieve.ts`
- Create: `packages/knowledge/src/retrieve.test.ts`
- Modify: `packages/knowledge/src/index.ts`

**Interfaces:**
- Consumes: `withTenant`, `TenantTx` from `@smos/db`; `Id`, `newId` from
  `@smos/domain`; `pg.Pool`; `Embedder`/`createFakeEmbedder` from
  `./embed.ts` (Task 4) for the test's fixture vectors; the
  `knowledge_document`/`knowledge_chunk` schema from Task 5.
- Produces: `type KnowledgeTier = "t1_authoritative" | "t2_reference" |
  "t3_hint" | "t4_voice"`, `interface RetrievedChunk { chunkId: Id;
  documentId: Id; tier: KnowledgeTier; text: string; distance: number; }`,
  and `retrieve(pool, workspaceId, input): Promise<RetrievedChunk[]>`,
  exported from `packages/knowledge/src/index.ts` for M2C's advisory agent
  to call. **The tier filter is a security control, not a convenience**
  (D3): a T3 chunk must never be returned to a query restricted to T1, no
  matter how close its vector match is — that is exactly what stops the
  agent's grounding check from being defeated by a closer-but-untrustworthy
  chunk.

- [ ] **Step 1: Add the dependencies**

```json
// packages/knowledge/package.json -- add these two top-level fields
  "dependencies": {
    "@smos/domain": "*",
    "@smos/db": "*",
    "pg": "8.23.0"
  },
  "devDependencies": {
    "@types/pg": "8.15.6"
  }
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/knowledge/src/retrieve.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { newId } from "@smos/domain";
import { createDb, createDbPool, withTenant } from "@smos/db";
import { createFakeEmbedder } from "./embed.ts";
import { retrieve } from "./retrieve.ts";

const APP_URL = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const MIGRATION_URL = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";

const pool = createDbPool(APP_URL);
const db = createDb(pool);
const migrationPool = createDbPool(MIGRATION_URL);
const embedder = createFakeEmbedder(1024);

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

const WORKSPACE = newId();

beforeAll(async () => {
  await db.execute(sql`insert into workspace (id, name) values (${WORKSPACE}::uuid, 'retrieve-tier-filter')`);
});

afterAll(async () => {
  await migrationPool.query("delete from knowledge_chunk where workspace_id = $1", [WORKSPACE]);
  await migrationPool.query("delete from knowledge_document where workspace_id = $1", [WORKSPACE]);
  await migrationPool.query("delete from workspace where id = $1", [WORKSPACE]);
  await migrationPool.end();
  await pool.end();
});

describe("retrieve -- tier-filtered vector search", () => {
  it("never returns a t3_hint chunk to a query restricted to t1_authoritative, even when the t3 chunk is the closer vector match", async () => {
    const [queryVector, t1Vector] = await embedder.embed(["gia bao nhieu", "chinh sach bao hanh 12 thang"]);

    const t1DocId = newId();
    const t1ChunkId = newId();
    const t3DocId = newId();
    const t3ChunkId = newId();

    await withTenant(pool, WORKSPACE, async (tx) => {
      await tx.query(
        `insert into knowledge_document (id, workspace_id, tier, title) values ($1, $2, 't1_authoritative', 'Bang gia chinh thuc')`,
        [t1DocId, WORKSPACE],
      );
      await tx.query(
        `insert into knowledge_chunk (id, workspace_id, document_id, ordinal, text, embedding) values ($1, $2, $3, 0, 'chinh sach bao hanh 12 thang', $4::vector)`,
        [t1ChunkId, WORKSPACE, t1DocId, toVectorLiteral(t1Vector!)],
      );

      await tx.query(
        `insert into knowledge_document (id, workspace_id, tier, title) values ($1, $2, 't3_hint', 'Website cu, chua cap nhat')`,
        [t3DocId, WORKSPACE],
      );
      // The t3 chunk's embedding is set to the query vector itself, so its
      // distance is exactly 0 -- the closest possible match, strictly
      // closer than the t1 chunk above. If the tier filter were a
      // convenience rather than an enforced WHERE clause, this chunk
      // would win.
      await tx.query(
        `insert into knowledge_chunk (id, workspace_id, document_id, ordinal, text, embedding) values ($1, $2, $3, 0, 'gia bao nhieu, hoi nam ngoai', $4::vector)`,
        [t3ChunkId, WORKSPACE, t3DocId, toVectorLiteral(queryVector!)],
      );
    });

    const results = await retrieve(pool, WORKSPACE, {
      queryEmbedding: queryVector!,
      tiers: ["t1_authoritative"],
      limit: 5,
    });

    expect(results.map((r) => r.chunkId)).not.toContain(t3ChunkId);
    expect(results.map((r) => r.chunkId)).toContain(t1ChunkId);
    for (const r of results) {
      expect(r.tier).toBe("t1_authoritative");
    }
  });

  it("orders results by ascending cosine distance within the allowed tiers", async () => {
    const [queryVector] = await embedder.embed(["bao hanh"]);
    // A tiny, deterministic perturbation (one dimension flipped) stays
    // nearly identical in direction -- guaranteed small cosine distance --
    // without depending on the fake embedder's hashes being semantically
    // "close" for related Vietnamese phrases, which they are not.
    const nearVector = queryVector!.map((v, i) => (i === 0 ? -v : v));
    const [farVector] = await embedder.embed(["mot chu de hoan toan khac, khong lien quan"]);

    const docId = newId();
    const nearChunkId = newId();
    const farChunkId = newId();

    await withTenant(pool, WORKSPACE, async (tx) => {
      await tx.query(`insert into knowledge_document (id, workspace_id, tier, title) values ($1, $2, 't1_authoritative', 'FAQ bao hanh')`, [
        docId,
        WORKSPACE,
      ]);
      await tx.query(
        `insert into knowledge_chunk (id, workspace_id, document_id, ordinal, text, embedding) values ($1, $2, $3, 0, 'far chunk', $4::vector)`,
        [farChunkId, WORKSPACE, docId, toVectorLiteral(farVector!)],
      );
      await tx.query(
        `insert into knowledge_chunk (id, workspace_id, document_id, ordinal, text, embedding) values ($1, $2, $3, 1, 'near chunk', $4::vector)`,
        [nearChunkId, WORKSPACE, docId, toVectorLiteral(nearVector)],
      );
    });

    const results = await retrieve(pool, WORKSPACE, { queryEmbedding: queryVector!, tiers: ["t1_authoritative"], limit: 5 });

    const nearIndex = results.findIndex((r) => r.chunkId === nearChunkId);
    const farIndex = results.findIndex((r) => r.chunkId === farChunkId);
    expect(nearIndex).toBeGreaterThanOrEqual(0);
    expect(farIndex).toBeGreaterThanOrEqual(0);
    expect(results[nearIndex]!.distance).toBeLessThan(results[farIndex]!.distance);
    expect(nearIndex).toBeLessThan(farIndex);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/knowledge/src/retrieve.test.ts`
Expected: FAIL — `Cannot find module './retrieve.ts'`, because the file
does not exist yet.

- [ ] **Step 4: Write the implementation**

```ts
// packages/knowledge/src/retrieve.ts
import type pg from "pg";
import type { Id } from "@smos/domain";
import { withTenant } from "@smos/db";

export type KnowledgeTier = "t1_authoritative" | "t2_reference" | "t3_hint" | "t4_voice";

export interface RetrievedChunk {
  chunkId: Id;
  documentId: Id;
  tier: KnowledgeTier;
  text: string;
  distance: number;
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * The tier filter is a security control, not a convenience (D3,
 * docs/superpowers/specs/2026-08-18-customer-advisory-agent-design.md
 * section 2): it is a WHERE clause evaluated by PostgreSQL against
 * knowledge_document.tier, before ORDER BY ever ranks anything. A T3
 * chunk closer in vector space than every T1 chunk still cannot be
 * returned to a T1-only query -- the query never sees it in the first
 * place, the same way RLS never lets the wrong workspace's rows into a
 * result set to begin with.
 *
 * Runs inside withTenant (packages/db/src/tenant-scope.ts) so the tenant
 * boundary is enforced by PostgreSQL's RLS itself, not by this function's
 * own SQL -- exactly the discipline every other read in this codebase
 * follows.
 */
export async function retrieve(
  pool: pg.Pool,
  workspaceId: Id,
  input: { queryEmbedding: number[]; tiers: KnowledgeTier[]; limit: number },
): Promise<RetrievedChunk[]> {
  if (input.tiers.length === 0) {
    throw new Error("retrieve requires at least one tier in input.tiers");
  }
  if (!Number.isFinite(input.limit) || input.limit <= 0) {
    throw new Error(`retrieve requires a finite limit > 0, got ${input.limit}`);
  }

  const vectorLiteral = toVectorLiteral(input.queryEmbedding);

  const result = await withTenant(pool, workspaceId, (tx) =>
    tx.query(
      `SELECT c.id AS chunk_id, c.document_id, d.tier, c.text, (c.embedding <=> $1::vector) AS distance
       FROM knowledge_chunk c
       JOIN knowledge_document d ON d.id = c.document_id AND d.workspace_id = c.workspace_id
       WHERE d.tier = ANY($2::text[])
       ORDER BY c.embedding <=> $1::vector
       LIMIT $3`,
      [vectorLiteral, input.tiers, input.limit],
    ),
  );

  return result.rows.map((row) => ({
    chunkId: row.chunk_id as Id,
    documentId: row.document_id as Id,
    tier: row.tier as KnowledgeTier,
    text: row.text as string,
    distance: Number(row.distance),
  }));
}
```

```ts
// packages/knowledge/src/index.ts (add this line)
export { type KnowledgeTier, type RetrievedChunk, retrieve } from "./retrieve.ts";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/knowledge/src/retrieve.test.ts`
Expected: PASS — 2 tests green.

- [ ] **Step 6: Run verify and commit**

Run: `npm run verify`
Expected: exits 0.

```bash
git add packages/knowledge/package.json packages/knowledge/src/retrieve.ts packages/knowledge/src/retrieve.test.ts packages/knowledge/src/index.ts
git commit -m "$(cat <<'EOF'
feat(knowledge): add tier-filtered retrieval

Cosine-distance search over knowledge_chunk, scoped by withTenant and
filtered to caller-specified tiers via a WHERE clause evaluated before
ORDER BY -- proved that a closer t3_hint chunk cannot leak into a
t1_authoritative-only query, which is the property M2C's grounding
enforcement will depend on.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

**Spec coverage** (scope: sections 2 D6/D7, 4.1, 4.3 of the design spec):

- D6 (NFC normalisation mandatory before chunking/embedding/querying) →
  Task 2, with the decomposed/composed byte-identity test the task
  explicitly required.
- D7 (two dependencies only) → honoured throughout: zero new npm packages
  added by this plan; the Global Constraints section states explicitly why
  `pg`/`@types/pg`/`@smos/db`/`@smos/domain` reuse in Task 6 doesn't count.
- 4.1 (`knowledge_document` with NOT NULL tier CHECK, `knowledge_chunk` with
  `embedding vector(1024)` and composite FK, RLS enabled+forced with both
  USING/WITH CHECK, composite `(id, workspace_id)` FK) → Task 5, migration
  0039, with adversarial cross-tenant read, cross-tenant write, and the
  composite-FK forged-attach test.
- 4.3 (NFC-normalise, chunk, embed, store, query by cosine distance with a
  tier filter, no framework) → Tasks 2–4 and 6 cover normalise/chunk/embed/
  retrieve; Task 5 is the store. "No framework" is honoured — zero new
  dependencies anywhere in this plan.
- The Anthropic provider (highest-value M2A task per the brief, also
  unblocking the $5 canary) → Task 1, with `costUsd` computed from real
  token usage times configured prices, `maxOutputTokens` honoured as a hard
  ceiling, and every test driven by an injected fake `fetch`.

**Requirement in scope I could not cover with a task:** none. Everything the
brief listed under "WHAT THIS PLAN COVERS" (Tasks 1–6) has a task.
Ingestion orchestration that *calls* normalise → chunk → embed → store in
one pipeline function, a real (non-fake) embedding provider, and anything
about the advisory agent's grounding enforcement are explicitly M2C's scope
per the plan index's dependency table ("M2C ... Blocked by: M2A and M2B"),
not M2A's — so they are correctly absent here, not a gap.

**Placeholder scan:** no "TBD", no "add error handling" without showing the
handling, no "similar to Task N" — every test file above has real
assertions and every implementation file above is complete, runnable code.

**Type-name consistency check against the index's Interface contract:**

- `AnthropicProviderConfig` fields (`apiKey`, `model`, `maxOutputTokens`,
  `inputUsdPerMTok`, `outputUsdPerMTok`) match exactly; `createAnthropicProvider`
  returns `ModelProvider` for the one-argument call, with the disclosed
  `fetchImpl` extension noted up front rather than silently diverging.
- `normaliseVietnamese(text: string): string` — matches.
- `Chunk { text: string; ordinal: number; }` and `chunkDocument(text:
  string, maxChars: number): Chunk[]` — matches.
- `Embedder { readonly name; readonly dimensions; embed(texts: string[]):
  Promise<number[][]> }` and `createFakeEmbedder(dimensions: number):
  Embedder` — matches.
- `KnowledgeTier`, `RetrievedChunk { chunkId; documentId; tier; text;
  distance }`, and `retrieve(pool: pg.Pool, workspaceId: Id, input: {
  queryEmbedding: number[]; tiers: KnowledgeTier[]; limit: number }):
  Promise<RetrievedChunk[]>` — matches field-for-field, including using
  `Id` from `@smos/domain` for `chunkId`/`documentId` as the contract's own
  `Id` type implies.
- Cross-task consistency: Task 3's `Chunk.ordinal` is what Task 5's
  `knowledge_chunk.ordinal` column stores; Task 4's `Embedder.embed` return
  shape (`number[][]`) is exactly what Task 6's test feeds into
  `toVectorLiteral` and `retrieve`'s `queryEmbedding: number[]`. No renamed
  or reshaped symbol between where a task defines something and where a
  later task consumes it.

**Where the index's interface contract seemed wrong or insufficient:** one
place, disclosed above rather than silently patched —
`createAnthropicProvider(cfg): ModelProvider` as literally written gives no
way to satisfy "tests must never call the paid API" other than monkey-
patching the global `fetch`, which every other HTTP-calling module in this
codebase (`guardedFetch`, `createMetaAdapter`) deliberately avoids in favor
of an injected, optional `fetchImpl` parameter. This plan adds that same
parameter rather than either (a) silently diverging from the fixed
signature by giving `createAnthropicProvider` a different shape, or (b)
leaving the task untestable. No other gap or inconsistency found.
