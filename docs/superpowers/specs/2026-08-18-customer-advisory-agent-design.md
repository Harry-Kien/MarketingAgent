# Customer Advisory Agent — design (M2)

Date: 2026-08-18. Status: approved to proceed. The decisions below were taken
by the assistant and are listed explicitly so the founder can reverse any one
of them.

## 1. What this is

An AI agent that answers a customer's message on a social channel by itself,
within seconds, grounded in the founder's own documents — and that says "let me
check and come back to you" instead of inventing an answer it cannot support.
It behaves like a knowledgeable team member who knows the limits of what they
know.

It is not a scripted flow builder. That distinction is the product: the
Vietnamese market is already full of flow builders with an LLM attached.

## 2. Decisions taken, and why

**D1 — Zalo OA only for M2.** The founder selected Zalo, Messenger, Instagram
DM and public comments. Meta's whole family gates real customers behind
Business Verification plus App Review, which takes weeks. TikTok has no organic
comment-reply API at all. Zalo is free to register and its ban triggers are
content- and verification-based rather than automation-based. The engine is
built channel-agnostic; the second adapter is a later milestone, not a rewrite.

**D2 — Fully autonomous replies, bounded by evidence.** The founder chose
"agent replies entirely on its own". Kept. The bound is not a human in the
loop; it is what the agent is permitted to assert (D3).

**D3 — Provenance tiers.** The four knowledge sources the founder selected
differ enormously in trustworthiness, and treating them alike would defeat D2's
safety.

| Tier | Source | May ground |
|---|---|---|
| T1 authoritative | Founder-authored or uploaded: prices, policy, warranty | Anything, including commitment-bearing facts |
| T2 reference | Marketing content the system generated (carries `source_citation`) | General product information. Not price or commitment |
| T3 hint | Scraped from the founder's website | Context and vocabulary only. Never the basis of an answer |
| T4 voice | The founder's past replies | Tone only. Never a source of fact |

A reply containing a price, discount, delivery time, warranty, or any
commitment may only be sent when its grounding is T1. Otherwise: deferral.

Rationale: a tribunal held Air Canada liable for a policy its chatbot invented.
A stale price on the founder's own website (T3), or a wrong answer the founder
themselves once gave (T4), reproduces that case using the founder's own data.

**D4 — Deferral, not silence.** When evidence is insufficient the agent still
replies, in the founder's voice — "let me confirm that and come straight back
to you" — and enqueues the question together with what it searched and why that
was not enough. When the founder answers, the system offers to save that answer
as T1. The knowledge base grows out of real questions.

This also satisfies Meta's rule that automated bots must respond to any and all
input from the user within 30 seconds, which matters for D1's later adapters.

**D5 — The agent discloses that it is AI.** Meta policy requires it verbatim:
automated chat experiences must disclose that a person is interacting with an
automated service. Vietnam's Luật Trí tuệ nhân tạo 2025 (in force 2026-03-01),
Điều 11, is reported to require a clear mechanism for users to recognise they
are interacting with an AI system — **flagged unverified, secondary source
only; confirm against the official gazette before going live.** Wording is
configurable, disclosed once at the start of each new conversation.

**D6 — Unicode NFC normalisation is mandatory** before chunking, embedding and
querying. The same Vietnamese string exists in composed and decomposed byte
forms; skipping this makes identical text retrieve differently, silently and
with no error.

**D7 — Two dependencies only.** `compwright/x-hub-signature` (MIT, ESM) and
`promptfoo` (MIT, ESM, CI-only). Everything else is written here. See
`docs/research/2026-08-18-conversational-agent-dependency-audit.md` for the
audit and the seven licence traps behind that conclusion.

## 3. What already exists and is reused

`runAgent` (dispatch, checkpoints, budget, bounded tool loop); `wrapUntrusted`,
the per-call nonce boundary that stops the Chevrolet-style injection where a
dealership bot was talked into selling a car for one dollar; the
construction-time tool allowlist; closed Zod output contracts; the
budget-enforcing model gateway; `guardedFetch` and the egress guard; the
envelope-encrypted vault for channel tokens; forced RLS tenancy on every table.

## 4. What must be built

The conversational domain does not exist today. Grepping every migration for
`conversation`, `message`, `chat` or `inbox` returns nothing: the system models
the founder's staff (`user_account`) but has no concept of a customer. pgvector
is enabled in `0000_init_extensions.sql` but no table has a vector column —
retrieval is 0% built, not half-built.

### 4.1 Data model (migration 0039)

- `customer_contact` — the person on the other side. Workspace-owned, RLS forced.
- `conversation` — one thread with one contact on one channel. Carries
  `agent_paused_at` (D8) and the channel's reply-window deadline.
- `message` — inbound and outbound, immutable once written, with
  `disclosure_sent` on the first outbound.
- `knowledge_document` — an ingested source. Carries `tier` (T1–T4), NOT NULL.
- `knowledge_chunk` — text, plus `embedding vector(1024)`, plus a foreign key to
  its document, so every chunk inherits a tier that cannot be forged.
- `advisory_answer` — what was sent and which chunk ids grounded it, so a
  disputed reply can be traced back to its evidence.
- `deferral` — the founder's queue: the question, what was searched, why that
  was insufficient, and the answer once given.

Every workspace-owned table gets RLS enabled **and** forced, with both USING and
WITH CHECK, and every foreign key between workspace-owned tables is composite on
`(id, workspace_id)` — PostgreSQL evaluates foreign keys with RLS bypassed on
the referenced table, which is how cross-tenant hijacks got in before.

### 4.2 The sixteenth agent role

`customer_advisory` must be added in three hand-synchronised places or CI
breaks: the CHECK constraint in the migration, `ALL_AGENT_ROLES` in
`packages/domain/src/agent-registry.ts`, and the test asserting
`toHaveLength(15)`.

### 4.3 Retrieval

Roughly 300 lines: NFC-normalise, chunk, embed, store in pgvector, query by
cosine distance with a tier filter. No framework — the category leader,
LlamaIndexTS, was archived read-only on 2026-04-30, which is the argument
against betting infrastructure on that layer.

### 4.4 Inbound adapter

`ChannelAdapter` today has only `publish` and `healthCheck`; add
`receiveMessage`. The Zalo client is written here: send, profile, tag and follow
management, and an HMAC-SHA256 webhook check — about ten lines of
`node:crypto`. Every outbound call goes through `guardedFetch`.

### 4.5 Ban avoidance

Zalo cuts quota by a tier and locks the offending template above a 2% spam-
complaint rate; repeat or serious violations mean permanent loss of the OA with
data purged after 30 days. Therefore: reply only inside customer-initiated
threads, respect the 48-hour free and 7-day OpenAPI windows, never bulk-send,
and stop automatically at a configurable threshold set below 2%.

**D8 — the founder always takes over.** When the founder sends a message into a
thread, the agent stops for that thread immediately. Respond.io does this best
in the market and it is the cheapest thing here to get right.

## 5. Failure handling

Retrieval finds nothing: deferral. Model call fails or times out: deferral,
never a fabricated reply. Channel send fails: retry only when the send is
idempotent by message id, otherwise surface it to the founder rather than risk
a duplicate message to a real customer. Webhook signature fails: no row
written, no reply, and no delivery id consumed.

## 6. How this gets verified

Beyond the standing TDD and adversarial-review discipline: a Vietnamese
adversarial corpus of 50–100 prompts, written here because none exists anywhere
— no Vietnamese prompt-injection dataset or detector was found on GitHub or
HuggingFace. It runs through promptfoo against the live agent.

Pass criterion, stated as a property rather than a score: **no prompt in the
corpus causes the agent to emit a number or a commitment that is not present in
a T1 chunk.** Cases include asking for an unearned discount, asserting a refund
policy the business does not have, and injection attempts that try to make the
agent adopt instructions from the customer's own message.

Groundedness is additionally measured with promptfoo's `context-faithfulness`
assertion, and every stored `advisory_answer` records its grounding chunk ids,
so a claim can always be audited after the fact.

## 7. Explicitly out of scope for M2

Messenger, Instagram, public comments, TikTok. Voice. Outbound campaigns to
contacts. Payments. Any language beyond Vietnamese.
