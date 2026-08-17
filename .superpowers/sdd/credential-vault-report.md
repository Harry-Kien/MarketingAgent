# Credential vault — report

**Status**: complete. `npm run verify` green in the foreground, 3 consecutive runs (103 test files / 1594 tests, exit 0).

**Commits** (branch `feat/credential-vault`):
- `df95266` — envelope-encrypted vault (`packages/vault`, migration `0036_vault_secret.sql`), webhook root secret moved onto it.
- `13f15c1` — fixed a pre-existing, unrelated flakiness in webhook rate-limit tests (see "Split" below).
- `3bd6223` — adversarial self-review tests (wrapped-key substitution, rotation replay).

## Envelope design

A fresh random 256-bit data key (DEK) encrypts each secret's plaintext with AES-256-GCM. The DEK itself is wrapped (also AES-256-GCM) by a key-encryption key (KEK) obtained from a narrow `KmsProvider` interface, and `vault_secret` stores only the two ciphertexts (plus IV/auth-tag pairs) — never a plaintext secret, a DEK, or a KEK.

## Where the KEK lives, and what that does and does not protect

The KEK lives **outside PostgreSQL entirely**, in process environment variables, read by `packages/vault/src/providers/env-kms-provider.ts` — explicitly named and documented as **local-development-only**, not a hosted KMS, so it cannot be mistaken for one. This defeats an attacker who has full SQL access to the application database (`smos_app` or even `smos_vault`) but holds nothing else: they get ciphertext and, for `smos_app`, not even that. It does **not** defend against an attacker with access to the web process's environment or host — that threat surface is identical to any env-var-held secret today (e.g. `BETTER_AUTH_SECRET`). A real KMS (AWS KMS / GCP KMS / HashiCorp Vault Transit) implements the same `KmsProvider` interface with no other code change; that swap has not been made in this milestone.

## `smos_app` reach

Zero grants on `vault_secret` — not RLS-filtered, actually refused. Proven live (not asserted): direct SELECT/INSERT/UPDATE/DELETE as `smos_app` all fail with `permission denied`. `smos_app` cannot reach ciphertext or plaintext. Only `smos_vault` — a separate login role, member of neither `smos_app` nor vice versa, its own credential (`DATABASE_VAULT_URL`) — can touch the table, and only with SELECT/INSERT/UPDATE (no DELETE).

## Rotation

`rotateSecretKek` re-wraps the DEK under a new KEK id without touching `ciphertext`/`iv`/`auth_tag`; a DB trigger (`vault_secret_rotation_only`) makes this a structural fact, not a TypeScript promise. Proved live: ciphertext/iv/auth_tag are byte-identical before/after rotation, only the wrap and `kek_id` change, and the secret still opens correctly through the new wrap. Honest limit, proven not asserted (`adversarial.test.ts`): rotating the row does **not** retroactively revoke a ciphertext/wrapped-key snapshot an attacker exfiltrated *before* rotation, as long as the old KEK material still exists somewhere — retiring the old KEK from the provider (deleting its env var once every row is rotated) is the step that actually closes that exposure.

## Adversarial self-review (attacker holding valid `smos_app`)

- Read another workspace's ciphertext / own workspace's plaintext: impossible — zero grants (above).
- Substitute one workspace's wrapped key for another's: fails loudly with `VaultTamperError` (AES-GCM auth tag binds key correctness; no app-level check needed), proven by actually grafting A's wrap columns onto B's row through the one write path the trigger allows.
- Replay old ciphertext after rotation: succeeds only while the old KEK is still held by the provider (see Rotation above) — disclosed, not hidden.
- Error-path key leak: no logging anywhere in `packages/vault`; the one caller that logs (`webhook-secret.ts`) logs only `error.name`, never `.message` or the error object; `VaultTamperError`'s message is a fixed string with no bytes.

## Mutation testing (each protection removed live against real Postgres, confirmed RED, restored, confirmed GREEN)

| Protection | Tests caught |
|---|---|
| RLS enabled+forced on `vault_secret` | 4/4 |
| `smos_app` zero grants (temporarily granted) | 6/6 |
| Rotation-only trigger (dropped) | 2/2 |
| `UNIQUE(workspace_id, slug)` (dropped) | 1/1 |
| `smos_vault` no-DELETE (DELETE granted) | 1/1 |
| App-layer workspace-mismatch check (removed) | 1/1 |
| `redact.ts` new patterns (reverted) | 5/5 |
| Envelope `VaultTamperError` classification (removed) | 2/2 |

8 protections, all caught. No unlocked protection found.

## Webhook root secret

Now per-tenant. `deriveWorkspaceSecret`/`META_WEBHOOK_SECRET` deleted entirely; each workspace gets an independently random 32-byte secret, generated on first use via `getOrCreateSecret` and stored sealed. A leaked workspace secret now reveals nothing about any other workspace's.

## Split with the other track

The intermittent 429-vs-401 failures I found and fixed (`13f15c1`) were a **pre-existing statistical flakiness** in hardening-task-1's rate-limiter tests (hash-bucket collisions across files/tests sharing `webhook-rate-limit.ts`'s fixed-cardinality buckets), reproduced with files I never touched the logic of, and existing before this task started. Not a branch/database split with the other agent. One real, disclosed production finding came out of investigating it — a forged flood against tenant A can cost tenant B a rejected-signature audit receipt via the shared `invalid_global` bucket (delivery-loss is NOT possible: `valid_workspace` is a separate scope forged traffic can never reach, proven live) — the coordinator is taking that as a separate follow-up; I did not touch production rate-limiter code.

## Concerns

- KEK placement is a local-dev stand-in (env vars), not a real KMS — swap is designed for but not built.
- Rotation doesn't retroactively revoke already-exfiltrated snapshots until the old KEK is retired — operational discipline required.
- No secret-*value* rotation yet (e.g. replacing a refreshed OAuth token) — only KEK-version rotation; `putSecret` refuses to overwrite an existing slug by design, deferred to when M2 needs real token refresh.
- `invalid_global` cross-tenant audit-completeness gap is the coordinator's to fix, not mine.
