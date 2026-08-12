# P4 Track C report — Adapter SDK + Egress Guard (Tasks 1 & 2)

Worktree: `d:\MA-p4`, branch `feat/p4-guards`.

Commits (in order):
- `9b6ce06` feat(integrations): add adapter sdk and error taxonomy — **Task 1**
- `0983ae9` feat(integrations): block ssrf with an egress guard beyond string matching (T8) — **Task 2**
- `f8583ba` fix(integrations): close deprecated IPv4-compatible IPv6 gap in egress guard — hardening fix found during adversarial self-review, see below
- `cbee61d` docs(integrations): note assertResolvedAddressAllowed expects canonical input — doc clarification found during the same review

Task 3 (migration) was explicitly out of scope and not touched. No `@smos/db` import, no migration file written, no PostgreSQL connection made or opened by any code in this worktree's changes.

---

## Task 1 — Adapter SDK and error taxonomy

Files: `packages/integrations/package.json`, `tsconfig.json`, `src/adapter.ts`, `src/errors.ts`, `src/errors.test.ts`, `src/index.ts`. Root `tsconfig.json` gained a `{ "path": "./packages/integrations" }` reference (matching the convention every other package uses — no package-level `tsconfig.json` in this repo declares its own cross-package `references`, only the root does).

Built exactly to the plan's interfaces: `ERROR_KINDS` (six kinds), `isRetryable`, `AdapterError` (`kind`, `retryable`, `retryAfterMs`, `safeMessage`), and `ChannelAdapter` / `PublishInput` / `PublishResult` in `adapter.ts`.

One deviation worth flagging: the plan's `AdapterError` constructor calls `redact(message)` expecting it to scrub a token like `EAAxxxxx` out of free text. I checked `@smos/telemetry`'s actual `redact()` implementation (`packages/telemetry/src/redact.ts`) — it only masks values under sensitive *object keys* and connection-string passwords; a bare string with no keys passes through unchanged. So `redact("token EAAxxxxx expired")` alone does **not** redact anything. The plan's own example code already appended a second regex pass (`/\b(EAA|sk-|ghp_)[A-Za-z0-9_-]+/g`) for exactly this reason — I kept that, and it does the actual work here. Confirmed by reading `redact.test.ts`'s "masks connection strings" case and its absence of any bare-string-token case.

### TDD evidence

Failing run (before `errors.ts`/`adapter.ts` existed):
```
Cannot find module './errors.ts' imported from D:/MA-p4/packages/integrations/src/errors.test.ts
```

Passing run after implementation (`npx vitest run packages/integrations/src/errors.test.ts --reporter=verbose`):
```
✓ error taxonomy > covers the six kinds an operator must distinguish
✓ error taxonomy > marks transient kinds retryable and permanent kinds not
✓ error taxonomy > carries retryAfterMs for rate limiting
✓ error taxonomy > never puts a token in the message
Test Files  1 passed (1)
     Tests  4 passed (4)
```

---

## Task 2 — Egress guard (T8, SSRF)

File: `packages/integrations/src/egress.ts`, test `src/egress.test.ts` (60 tests after the hardening fix, up from an initial 54).

I did not implement the plan's own example (`BLOCKED_HOST` regex against the raw hostname string) — it is exactly the kind of "blocklist of literal strings" the task brief said was worse than nothing, and it would have passed every one of the plan's own base tests without ever really checking an IP address, because all eight of the plan's base cases use `http://`, which a correct protocol check refuses before the IP logic ever runs. I kept those eight verbatim as a subset but added parallel `https://` cases (and many more) to actually exercise the address-blocking logic.

### Design, verified against Node's real URL parser before writing any TypeScript

I prototyped the algorithm as a standalone `.mjs` script and ran ~30 vectors through Node's real `URL` parser first, rather than guessing. Key empirical finding: for `https:`/`http:` (WHATWG "special" schemes), `new URL()` **already canonicalizes** IPv4 written as decimal (`2130706433`), octal (`0177.0.0.1`), hex (`0x7f000001`), and mixed/shorthand (`127.1`) into plain dotted-decimal (`127.0.0.1`) — and canonicalizes IPv4-mapped IPv6 into pure hex groups (`::ffff:127.0.0.1` → `[::7f00:1]`). This is standard WHATWG URL behavior (same algorithm `fetch`/undici use), not something I had to reimplement — so `assertEgressAllowed` only needs to classify the *already-canonical* hostname, which is a much smaller and more auditable job than parsing every encoding by hand.

`assertEgressAllowed(rawUrl, allowedHosts)`:
1. Parses with `new URL()`; malformed input throws (fail-closed).
2. Requires `protocol === "https:"`.
3. Refuses any userinfo (`username`/`password` non-empty) outright.
4. Calls `assertResolvedAddressAllowed(url.hostname)` — classifies the hostname:
   - `localhost` / `*.localhost` → blocked by name.
   - Bracketed IPv6 → parsed to a 128-bit BigInt, checked against blocked prefixes.
   - Dotted-decimal IPv4 → converted to a 32-bit int, checked against a range table.
   - Anything else (a real domain name) → not resolved, not checked (see DNS-rebinding ruling below).
5. Exact-match (`.includes()`, not substring/prefix) against `allowedHosts`.

IPv4 blocked ranges: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (CGNAT), `127.0.0.0/8`, `169.254.0.0/16` (link-local, covers `169.254.169.254`), `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4` through `255.255.255.255` (multicast/reserved/broadcast).

IPv6 blocked outright: `::`/128, `::1`/128, `fc00::/7` (unique-local, covers AWS's `fd00:ec2::254`), `fe80::/10`, `ff00::/8`. IPv6 forms that **embed** an IPv4 address are extracted (low 32 bits, or bits 16–47 for 6to4) and the embedded address is re-checked against the same IPv4 table: IPv4-mapped (`::ffff:0:0/96`), NAT64 well-known prefix (`64:ff9b::/96`), 6to4 (`2002::/16`), and — added in the hardening fix — the deprecated IPv4-compatible form (`::/96`, e.g. `::127.0.0.1`).

### TDD evidence

Failing run (before `egress.ts` existed, whole suite failed on module resolution — this covers every one of the 54 initial cases including all the bypass-vector tests, since none could run without the module):
```
Error: Cannot find module './egress.ts' imported from D:/MA-p4/packages/integrations/src/egress.test.ts
Test Files  1 failed (1)
     Tests  no tests
```

Passing run after first implementation: 54/54.

Then, during the adversarial self-review pass (see below), I found the deprecated-IPv4-compatible gap, added two more test cases, ran them and watched them fail for the right reason before fixing:
```
FAIL > refuses deprecated IPv4-compatible form embedding loopback ([::127.0.0.1])
  expected [Function] to throw error matching /blocked|internal/i but got
  'Host [::7f00:1] is not on the egress allowlist'
FAIL > refuses deprecated IPv4-compatible form embedding metadata ([::169.254.169.254])
  expected ... but got 'Host [::a9fe:a9fe] is not on the egress allowlist'
Tests  2 failed | 54 skipped (56)
```
(Note these still *threw* — just for the wrong reason: rejected only because an IP literal can never string-equal a domain name in `allowedHosts`, not because the address-classification logic recognized it as internal. That distinction matters because the guard's contract doesn't forbid a caller from allowlisting an IP literal directly, in which case this would have been a real, live bypass rather than an accidentally-safe one.)

After adding `["::", 96]` to the embedding-prefix table: 60/60 passing, confirmed with `npx vitest run packages/integrations --reporter=verbose`.

### Bypass attempts and outcomes (adversarial self-review)

| Attempt | Outcome |
|---|---|
| Decimal/octal/hex/mixed IPv4 (`2130706433`, `0177.0.0.1`, `0x7f.1`, `127.1`, `0x7f000001`, `017700000001`) | Blocked — WHATWG URL canonicalizes to dotted-decimal before the check ever runs; verified with a real vector table, not assumed |
| IPv6 loopback `[::1]`, unspecified `[::]` | Blocked |
| IPv4-mapped IPv6 `[::ffff:127.0.0.1]` / canonical `[::ffff:7f00:1]` / metadata `[::ffff:169.254.169.254]` | Blocked — embedded v4 extracted and re-checked |
| Unique-local `fc00::/7`, incl. AWS's `fd00:ec2::254` | Blocked |
| Link-local `fe80::/10`, `169.254.0.0/16` incl. `169.254.169.254` | Blocked |
| NAT64 well-known prefix `64:ff9b::7f00:1` (embeds `127.0.0.1`) | Blocked — not in the plan, added because some resolvers do NAT64 synthesis |
| 6to4 `2002:7f00:1::` (embeds `127.0.0.1`) | Blocked — same reasoning |
| Deprecated IPv4-compatible `::127.0.0.1` / `::169.254.169.254` | **Initially NOT blocked by the address check** (only incidentally rejected via allowlist mismatch) — found by deliberately trying every IPv4-embedding IPv6 form I could think of, confirmed failing, then fixed. See fix commit `f8583ba`. |
| Userinfo smuggling `http://graph.facebook.com@169.254.169.254/`, `https://allowed@169.254.169.254/` | Blocked — both by the outright userinfo refusal and, independently, because `url.hostname` (verified empirically) is the real host after the `@`, never the userinfo part |
| Userinfo in front of the *real* allowlisted host (`https://allowed@graph.facebook.com/`) | Blocked outright — no legitimate reason for a channel-adapter call to carry credentials in the URL, so refused regardless of where they point |
| Backslash-before-`@` parser-confusion trick (`https://graph.facebook.com\@evil.test/`) | **Not a bypass** — WHATWG URL treats `\` as a path separator for special schemes, so hostname stays `graph.facebook.com` (correct, legitimate host) and `@evil.test` lands in the path; verified this is *allowed*, proving the check reads `.hostname`, never the raw string |
| Percent-encoded dot (`graph.facebook.com%2eevil.test`) | Blocked — decodes to a literal lookalike subdomain, fails exact-match allowlist |
| Fullwidth dot / IDN homograph tricks | Not separately tested with a homograph, but by construction: any Unicode/Punycode transform of the hostname that isn't byte-for-byte `graph.facebook.com` fails the exact-match allowlist check, so this class fails closed by design, not by a dedicated rule |
| Case variation (`GRAPH.FACEBOOK.COM`) | Allowed — WHATWG URL lowercases hostnames; also defensively re-lowercased in this code |
| Lookalike subdomain (`graph.facebook.com.evil.test`) | Blocked (plan's own case, kept) |
| `localhost`, `sub.localhost` by name (not IP) | Blocked |
| Malformed/unparseable URL | Blocked (fail-closed) |
| Teredo tunneling (`2001::/32`) | **Not implemented — disclosed gap.** Teredo XORs the embedded client IPv4 with `0xFFFFFFFF` in the low 32 bits and is largely disabled by default on modern OSes; decoding it correctly is meaningfully more code for a rarely-enabled mechanism, so I scoped it out rather than half-implement it. If this needs closing, the fix is the same shape as NAT64/6to4: match `2001::/32`, XOR the low 32 bits, re-check against the IPv4 table. |
| A public address that merely starts with a blocked-looking octet (`172.32.0.1`, just past `172.16.0.0/12`) | **Allowed**, correctly — proves the range table does real arithmetic, not a `172\.` prefix match like the plan's own example |
| Legitimate call (`https://graph.facebook.com/v23.0/me?fields=id`) | Allowed — the guard is not simply refusing everything |

### `assertResolvedAddressAllowed` and non-canonical input (`cbee61d`)

Direct answer to "is this a real hole a caller can walk into": **not in the code as shipped today, but yes for any future caller that imports the function directly without reading the doc comment.**

- Today, `assertResolvedAddressAllowed` has exactly one caller: `assertEgressAllowed` itself, which always passes `url.hostname` from a `new URL()` parse. WHATWG `URL` guarantees that value is already canonical (decimal/octal/hex/mixed IPv4 all normalized to dotted-decimal, IPv6 to lowercase hex groups). So on the only call path that exists right now, there is no gap — every encoding trick in the bypass table above is neutralized before `assertResolvedAddressAllowed` ever runs.
- The function is exported from `index.ts` for reuse (specifically so a future DNS-rebinding-closing caller can pin a resolved address, per the ruling below). Because it's public, nothing stops a later piece of code from calling `assertResolvedAddressAllowed("2130706433")` directly with a raw, un-canonicalized string. My `IPV4_LITERAL` regex requires dots (`\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}`), so a bare decimal integer like `"2130706433"` matches neither the IPv4 nor the bracketed-IPv6 branch and falls through the "not a recognizable IP literal, treat as an unchecked domain name" path — i.e. it would NOT be blocked. That is a real hole for that hypothetical caller, not a hypothetical one, if they don't canonicalize first.
- I judged this acceptable to leave undecorated with extra parsing (rather than duplicating the WHATWG IPv4 parser inside `assertResolvedAddressAllowed` too) because the realistic future caller is a DNS-resolution wrapper, and `node:dns`/`node:net` always return canonical dotted-decimal or standard-form IPv6 — never a decimal/octal/hex-encoded string. The gap only bites a caller who hand-constructs a weird string, which isn't what DNS resolution produces. I documented this explicitly in the doc comment (`cbee61d`) precisely so nobody relies on this function to re-parse encoding tricks the way `assertEgressAllowed` does.

### DNS-rebinding ruling

**Explicitly accepted gap, stated in the code's doc comment on `assertEgressAllowed`.** This is a synchronous, no-I/O function per the plan's own signature (`(url, allowedHosts) => void`, not `Promise<void>`), and the task constraints forbid any real network activity from this package's code or tests. A hostname that resolves to a private/internal address only at connect time is **not** caught by this function — it only classifies literal IP hostnames and passes plain domain names through unchecked. I exported `assertResolvedAddressAllowed(address)` specifically so a future caller that *does* perform DNS resolution (almost certainly the Meta client in Task 3, out of my scope) can resolve first, pin the resolved address, and re-run the exact same range-check logic against it before connecting — rather than re-resolving after the check, which would reopen the gap. I did not build that resolve-and-pin wrapper myself, since it requires either a real DNS call (forbidden in this task's tests) or `node:dns`/`node:net` wiring that belongs with the actual HTTP client, not the pure guard.

### Redirect ruling

**Explicitly accepted, single-hop-only guard, stated in the code's doc comment.** `assertEgressAllowed` inspects exactly one URL string and has no HTTP client, so it cannot see a `30x` response or its `Location` header. A permitted host that redirects to a forbidden address is a real bypass for any caller that blindly follows redirects. The doc comment states the required calling convention explicitly: disable automatic redirect following (`fetch(..., { redirect: "manual" })` or equivalent) and call `assertEgressAllowed` again on every `Location` header before following it — this module only ever guards a single hop, and enforcing the "call it again per redirect" discipline is the responsibility of whichever HTTP client consumes it (again, out of scope here — no HTTP client exists yet in this package).

---

## Existing tests modified

None. No existing test file was touched, weakened, or deleted anywhere in the repository.

---

## `npm run verify`

Ran the full chain four times across this work (after Task 1, twice mid-Task-2, and once for the final record after the hardening fix). Every run showed the exact same single failure, always in the same place, never involving anything I touched:

```
FAIL packages/db/src/agent-run-terminal-state.test.ts > agent_run terminal state is actually terminal (fix round 1, IMPORTANT)
  > still allows a no-op update that names state but does not change it, even for a terminal run
error: agent_run <id> is terminal (succeeded): a terminal run is an immutable audit record and may not be modified further, except updated_at
```

Final run: **907 passed, 1 failed, 908 total** (Test Files: 54 passed, 1 failed).

This is pre-existing and out of scope, not something I introduced or can fix:
- I never imported `@smos/db`, never touched `packages/db`, never wrote or edited a migration.
- I read the relevant migration (`infra/migrations/0026_agent_run_terminal_state.sql`) — its trigger already contains the no-op exception the test expects (`IF NEW.state = OLD.state THEN RETURN NEW`), so the *file on disk* is not the buggy version. The most likely explanation is that the shared PostgreSQL instance (port 5433, used simultaneously by this worktree and the sibling `d:\Marketing Agent` / `d:\MA-p3` worktrees per my brief) has a stale applied-migration state — an earlier version of this trigger got installed and the migration tracker considers `0026` already applied, so it never re-ran `CREATE OR REPLACE FUNCTION` against the live database.
- Across the four runs it was not fully deterministic: one run additionally showed two unrelated failures in `packages/agents/src/runtime-db.test.ts` (different tests, gone on the next run) — consistent with genuine concurrent-DB contention from the sibling agents' own test suites hitting the same instance at the same time, exactly as the task brief warned could happen.
- All of my code's own gates are unconditionally green across every run: `lint:versions`, `lint:scope`, `lint:secrets`, `lint:imports`, `lint:migrations`, `lint:purity`, `typecheck`, `typecheck:web`, and all 60 tests in `packages/integrations`.

I did not attempt to fix this — doing so would mean either editing `packages/db`/a migration (explicitly forbidden) or running `npm run db:migrate` against the shared database (a write to shared infrastructure other agents depend on, also outside my mandate). I'm flagging it plainly rather than presenting a falsely-green report.

---

## Uncertain / worth a second look

- The `packages/db` failure above — I'm confident it's unrelated to my work but have not root-caused *why* the live DB is stale; whoever owns Task 3 (the migration writer) or the environment should confirm `npm run db:migrate` has actually applied `0026` as currently written to the shared instance.
- Teredo (`2001::/32`) is a known, disclosed, unclosed gap in the egress guard (see table above).
- No new npm dependency was added or needed for either task.
