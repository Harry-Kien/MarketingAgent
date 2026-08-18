# Dependency audit — conversational customer-advisory subsystem

Date: 2026-08-18. Method: every licence read from the raw file on the default
branch (raw.githubusercontent.com), never from the GitHub API, a badge, or
`package.json` metadata. That rule exists because this project was previously
almost misled by AutoGen, whose API reported CC-BY-4.0 while its actual
LICENSE-CODE was MIT (recorded as R15).

## Verdict: adopt exactly two dependencies

| Repo | Licence (raw) | ESM | Last commit | Why |
|---|---|---|---|---|
| `compwright/x-hub-signature` | MIT | `"type":"module"` | 2026-02-26 | Meta webhook HMAC (X-Hub-Signature) |
| `promptfoo/promptfoo` | MIT | `"type":"module"` | 2026-08-18 | Adversarial suite + `context-faithfulness` assertions, CI-only, never imported by the app |

## Build ourselves (with the reason, not as a default)

- **Zalo OA client** — no OA repo has a verifiable licence; see the trap list.
  The API surface is small: send, profile, tag/follow, HMAC webhook.
- **Zalo webhook signature** — one HMAC-SHA256 compare, ~10 lines of `node:crypto`.
- **Meta Messenger/Instagram client** — Meta never shipped a Node SDK, and
  archived its own official WhatsApp one. Community SDKs are 3-6 years stale
  against an API that reversions yearly. A `fetch` client through the existing
  `guardedFetch` is safer than any of them.
- **Retrieval** — pgvector is already installed. ~300 lines of SQL plus an
  embedding call. No framework earns its weight for retrieve -> prompt -> generate.
- **Vietnamese PII redaction** — VN phone (`0[35789]xxxxxxxx` / `+84`) and
  CCCD/CMND are fixed-format regex. No ML, no Python service in an ESM monorepo.
- **Vietnamese prompt-injection corpus** — none exists anywhere, in any repo or
  dataset. Write 50-100 adversarial VN prompts and run them through promptfoo.
- **Human-handoff queue** — a Postgres table and a small UI beats deploying Chatwoot.

## Licence and status traps found (the reason the raw-file rule exists)

1. `mastra-ai/mastra` — API says Apache-2.0. The raw `LICENSE.md` carves the
   `ee/` subdirectory out under a separate Enterprise licence. Metadata was
   MORE permissive than reality: the inverse of the AutoGen case.
2. `run-llama/LlamaIndexTS` — 3,076 stars, MIT, category leader, **archived
   read-only 2026-04-30**. Four months earlier this would have been a
   recommendation.
3. `KaiyoDev/zalo-bot-js` — 54 stars, MIT, actively maintained (2026-04-07),
   and targets the **wrong product**: the Zalo *Bot* API, not the Official
   Account API. Only reading the code reveals this.
4. `protectai/llm-guard` — README states "THIS PROJECT HAS BEEN ARCHIVED".
   `protectai/rebuff` is GitHub-archived with **no README notice at all** --
   only the repo flag shows it.
5. `VoltAgent/voltagent` — licence file is `LICENCE` (British spelling); a
   check for `LICENSE` 404s and would wrongly conclude "unlicensed".
6. `maziyarpanahi/openmed` — a search summary claimed Vietnamese PII packs.
   Reading the README disproved it: clinical de-identification only, zero
   mention of Vietnamese. An aggregated summary was simply wrong.
7. `chatwoot/chatwoot` — MIT core with a separate `enterprise/` directory.
   Same dual-licence shape as Mastra.

## Unlicensed (default copyright = all rights reserved, NOT free to use)

`kyled7/zalo-api`, `nh4ttruong/zalo-oa-api-wrapper`,
`StudyDeepLearningAI/zalo-nodejs-sdk`, `tungnguyentien/zalo-node-sdk`,
`daopk/zaloapi`, `snlangsuan/facebook-bot-messenger` — none has a LICENSE,
LICENSE.md, LICENSE.txt, LICENSE-CODE or COPYING file at the repo root.
A `license` field in `package.json` is metadata, not a grant.

## Two technical findings that change the design

- **Vietnamese needs Unicode NFC normalisation before chunking and embedding**,
  not word segmentation. The same Vietnamese string can exist in composed and
  decomposed byte forms; skipping normalisation makes identical text retrieve
  differently, silently and with no error. Classic word segmenters
  (underthesea, VnCoreNLP (GPLv3), pyvi, PhoNLP) are all Python or Java and
  largely unnecessary -- modern embedding models use their own subword tokenizers.
- **VN-MTEB (arXiv 2507.21500, EACL 2026 Findings) is the first Vietnamese-specific
  retrieval benchmark.** Before it, every "good at Vietnamese" claim -- vendor or
  open-source -- rested on generic multilingual MTEB, not Vietnamese evidence.
  Candidate models: BAAI/bge-m3 (MIT), AITeamVN/Vietnamese_Embedding (Apache-2.0,
  bge-m3 fine-tuned on ~300k Vietnamese triples).
