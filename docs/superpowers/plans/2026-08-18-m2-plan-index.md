# M2 Customer Advisory Agent — plan index

**Spec:** `docs/superpowers/specs/2026-08-18-customer-advisory-agent-design.md`
**Dependency audit:** `docs/research/2026-08-18-conversational-agent-dependency-audit.md`

M2 is decomposed into four plans. Each produces working, testable software on
its own and is reviewed independently. They are ordered by dependency, not by
importance.

| Plan | Delivers | Blocked by |
|---|---|---|
| **M2A** — model provider and knowledge base | A real Anthropic provider (also unblocks the $5 canary), document ingestion with NFC normalisation, chunking, embeddings in pgvector, and tier-filtered retrieval | nothing |
| **M2B** — conversation domain and Zalo channel | `customer_contact` / `conversation` / `message`, the Zalo OA client, HMAC webhook verification, `receiveMessage`, and the **channel-layer** reply-window and complaint-threshold guard | nothing (parallel with M2A) |
| **M2C** — the advisory agent | The sixteenth role, the advisory output contract, grounding enforcement, deferral, AI disclosure, and founder takeover | M2A and M2B |
| **M2D** — founder surface and adversarial proof | Inbox, deferral queue, knowledge management UI, the Vietnamese adversarial corpus, and promptfoo groundedness gates | M2C |

## Global Constraints

These bind every task in every M2 plan.

- Node 24.14.0, npm 11.9.0, TypeScript 7.0.2, ESM only. Relative imports end in
  `.ts` with `rewriteRelativeImportExtensions`; writing `.js` breaks Turbopack
  and Node type-stripping and is caught by `npm run lint:imports`.
- Every dependency pinned to an exact version, no range prefix. Enforced by
  `npm run lint:versions`.
- **Only two new dependencies are permitted across all of M2:**
  `compwright/x-hub-signature` and `promptfoo`. Any third requires stopping and
  asking. The audit doc explains why.
- PostgreSQL 17 + pgvector on host port **5433**. The app connects as
  `smos_app` (NOSUPERUSER, NOBYPASSRLS). Migrations run as `smos`.
- Migrations 0000–0038 are applied. Never edit an applied migration. **Numbers
  are reserved per plan so parallel tracks cannot collide** — this was corrected
  after M2B turned out to need two migrations, not one:

  | Plan | Reserved |
  |---|---|
  | M2A | 0039 |
  | M2B | 0040, 0041 |
  | M2C | 0042 onward |
  | M2D | none expected; ask before taking a number |
- Every workspace-owned table: `workspace_id`, RLS **enabled and forced**,
  policies carrying **both** USING and WITH CHECK. Every foreign key between
  two workspace-owned tables is **composite on `(id, workspace_id)`** with a
  matching UNIQUE on the referenced side — PostgreSQL evaluates foreign keys
  with RLS bypassed on the referenced table.
- Text columns that must carry content use a `~ '\S'` CHECK, never a length
  check. Functions schema-qualify their tables; `SET search_path = public` does
  not exclude `pg_temp`.
- No secret, credential, token or environment value in a migration or a test
  fixture. `npm run lint:secrets` enforces house rules.
- **No paid model call in any test or in CI, ever.** Tests use the deterministic
  fake provider. Embedding calls in tests use a fake embedder.
- TDD is verified, not assumed: write the failing test, run it, paste the
  failing output into the task report, then implement.
- Database invariants are proved against the real PostgreSQL by attempting the
  attack as `smos_app`. Never mock RLS, triggers, constraints, transactions or
  permissions.
- Ids come from `newId()`, never fixed literals — fixed workspace ids have
  already caused a real cross-file collision here. Clean up rows in a way that
  survives a failing test.
- `npm run verify` must exit 0 before every commit, run in the **foreground**.
- Commit style: lowercase conventional prefix, no emoji, body ending
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Interface contract

These signatures are fixed here so the four plans agree. A plan that needs to
change one must say so rather than diverging.

```ts
// M2A — packages/model-gateway/src/anthropic.ts
export interface AnthropicProviderConfig {
  apiKey: string;
  model: string;              // e.g. "claude-opus-5"
  maxOutputTokens: number;    // hard per-call ceiling
  inputUsdPerMTok: number;    // priced by the caller, not guessed by the provider
  outputUsdPerMTok: number;
}
// fetchImpl exists so a test can drive a fake HTTP response — the constraint
// "no paid model call in any test, ever" is unsatisfiable without it. Same
// injection seam as guardedFetch and createMetaAdapter already use here.
export function createAnthropicProvider(
  cfg: AnthropicProviderConfig,
  fetchImpl?: typeof fetch,
): ModelProvider;

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

// M2B — packages/integrations/src/adapter.ts (extend, do not replace)
export interface InboundMessage {
  channelMessageId: string; channelContactId: string; text: string; receivedAt: Date;
}
export interface ChannelAdapter {
  readonly name: string;
  healthCheck(): Promise<boolean>;
  publish(input: PublishInput): Promise<PublishResult>;
  sendDirectMessage(input: { channelContactId: string; text: string;
    idempotencyKey: string }): Promise<{ channelMessageId: string }>;
}
export function parseInbound(rawBody: string): InboundMessage[];

// M2C — packages/contracts/src/advisory-output.ts
export interface AdvisoryOutput {
  reply: string;
  groundingChunkIds: string[];   // empty only when kind === "deferral"
  kind: "answer" | "deferral";
  containsCommitment: boolean;   // the agent's own claim; verified independently
}
```

## The rule that governs M2C, stated once

A reply whose `containsCommitment` is true, **or which an independent check
finds to contain a price, discount, delivery time, warranty or promise**, may
only be sent when **all three** of the following hold. Otherwise the reply is
replaced by a deferral.

1. `groundingChunkIds` is **non-empty**.
2. Every id in it belongs to a `t1_authoritative` document.
3. Every id in it belongs to a chunk **actually retrieved during this turn**.

Conditions 1 and 3 were missing from the first draft of this rule and were
found by the M2C plan author, not by review. They are not pedantry:

- Without (1), `Array#every([])` returns `true`, so a reply with an empty
  grounding list and a commitment **passes**. This exact vacuous-true bug had
  already been found once in this project, in the Golden Sequence's
  `deliveries.every(...)` — and it recurred here in the spec that was written
  after that lesson.
- Without (3), a model can satisfy the rule by **emitting chunk ids it invented**,
  self-authorising a commitment with no evidence behind it.

The agent's own `containsCommitment` flag is never trusted on its own — it is
one input to a check that also runs independently of the model. An agent that
under-reports a commitment must not thereby gain permission to send it.
