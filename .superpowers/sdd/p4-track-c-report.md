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

---

## Fix round 1 (independent review response)

Reviewer ran 85 hostile URLs (81/81-that-should-refuse refused, zero bypasses), 14 parser-vs-`node:https` agreement checks (14/14), 8 legitimate URLs (8/8 pass), and 5 mutants (5/5 killed) against the code from the initial report. Two Important findings and a set of Minors came back. All addressed below, in `feat/p4-guards`, same worktree.

### Important #1 — `assertResolvedAddressAllowed` fails open on unbracketed IPv6 and non-canonical IPv4

**Failing tests written first, run, confirmed failing** (`packages/integrations/src/egress.test.ts`, new `describe("assertResolvedAddressAllowed (direct calls, not via assertEgressAllowed)")` block):

```
× throws for unbracketed ::1                    -> expected [Function] to throw an error
× throws for unbracketed fd00:ec2::254           -> expected [Function] to throw an error
× throws for unbracketed fe80::1                 -> expected [Function] to throw an error
× throws for unbracketed ::ffff:127.0.0.1        -> expected [Function] to throw an error
× throws for 2130706433                          -> expected [Function] to throw an error
× throws for 0x7f000001                          -> expected [Function] to throw an error
× throws for 127.1                               -> expected [Function] to throw an error
× throws for 0177.0.0.1                          -> expected [Function] to throw an error
× throws for 999.999.999.999 rather than returning silently -> expected [Function] to throw an error
× throws for 300.1.2.3 rather than returning silently        -> expected [Function] to throw an error
× throws for 1.2.3.4.5 rather than returning silently        -> expected [Function] to throw an error
× throws for ::1::2 rather than returning silently           -> expected [Function] to throw an error
× throws for fe80::zzzz rather than returning silently       -> expected [Function] to throw an error
Test Files  1 failed (1)
     Tests  13 failed | 2 passed | 56 skipped (71)
```

**Root cause:** the function required IPv6 to be bracketed and IPv4 to already be canonical dotted-decimal, silently falling through to "must be a domain name, therefore not checked" for anything else. `dns.resolve6` always returns unbracketed addresses; a raw caller can pass any encoding. The failure mode was silence, which is the wrong shape for a security boundary — the reviewer's framing is exactly right and is now the governing design rule for this function.

**Fix:** rewrote the classification to mirror how a real host parser (WHATWG URL) actually decides what a string is, independent of bracket/canonical-form assumptions, and to fail closed:
1. `localhost` / `*.localhost` (with a trailing FQDN dot stripped first) — blocked by name.
2. Contains `:` — an IPv6 attempt, bracketed or not (a domain name or IPv4 address never contains a colon). Parsed and range-checked; throws if it doesn't parse (`assertIPv6AddressAllowed`, unchanged, now reachable without brackets).
3. "Ends in a number" — mirrors the WHATWG URL host parser's own rule: the last `.`-separated label is decimal/octal/hex-number-shaped. If so, the *whole* host is an IPv4-parse attempt, all-or-nothing, using a from-scratch implementation of the URL spec's IPv4-number algorithm (`parseIPv4Part`, `parseIPv4Address` in `egress.ts`) — not a regex, not a reliance on `URL` canonicalization, since this function may now be called directly with raw strings. Throws if the parse fails (e.g. `999.999.999.999`'s out-of-range first octet) instead of falling through.
4. Anything else is a plain domain name — the one intentional, still-documented pass-through.

This also incidentally fixed the "IPV4_LITERAL doesn't range-check octets" Minor (`999.999.999.999` now throws on the direct path too — it was already refused via `assertEgressAllowed`'s protocol/allowlist checks, but not by the address check itself), and closed a self-found gap during the rewrite: a trailing FQDN dot (`"127.0.0.1."`) previously produced an empty last label, which `endsInANumber` read as "not IPv4-shaped" and let straight through as an unrecognised domain. Added a test and the one-line strip that closes it.

**Passing after the fix:** 85/85 in `packages/integrations`. **Correction (fix round 2):** the baseline this grew from was **60**, not 71 — 60 is the count at commit `77b3bd4` (the initial report, before any fix-round-1 code change); 71 was a mid-flight number from partway through this round's own test-writing and was never the right comparison point. 60 → 85 is the real delta for fix round 1.

### Important #2 — `guardedFetch(url, allowedHosts, init?)` wrapper

New file `packages/integrations/src/guarded-fetch.ts` + `guarded-fetch.test.ts`. Pins `redirect: "manual"` on every underlying `fetch` call (overriding whatever the caller's `init` said), re-runs the *full* `assertEgressAllowed` (not just the address check — the allowlist too) on the initial URL and on every resolved `Location` header before following it, and bounds the chain at `maxRedirects` (default 5, overridable via `init.maxRedirects`). `fetchImpl` is an injectable 4th parameter (defaults to global `fetch`) so tests never touch a real socket — driven entirely by a hand-rolled fake `fetch` built from the native `Response`/`Headers` globals (no new dependency).

**Failing test run before `guarded-fetch.ts` existed** (whole file, module-not-found — covers all 7 cases below):
```
Error: Cannot find module './guarded-fetch.ts' imported from .../guarded-fetch.test.ts
Test Files  1 failed (1)
     Tests  no tests
```

**Passing after implementation**, 7/7:
- refuses a 30x whose `Location` points at a forbidden (private-IP) host
- refuses a 30x whose `Location` points at a host simply not on the allowlist
- bounds a redirect loop instead of following it forever (proved via a real call counter, not just "eventually rejects")
- follows a redirect chain that stays within the allowlist and returns the final response
- still completes a legitimate, non-redirecting request against the fake (not simply refusing everything)
- refuses the initial URL itself before ever calling `fetch`, if it fails the guard (0 fake-fetch calls made)
- always calls the underlying fetch with `redirect: "manual"`, even if the caller's `init` said otherwise

One test-quality issue found and fixed during mutation testing (see below): the first redirect test originally only asserted `.rejects.toThrow()` with no message check, so a mutant that skipped re-checking the guard on redirect hops still "passed" it — the fake fetch has no script entry for the forbidden URL either, so it throws its own unrelated `"no script entry"` error, which also satisfies a bare `.toThrow()`. Strengthened to assert the guard's own `/blocked|internal/i` wording, same as the second redirect test already did.

### Mutation testing

I do not have access to whatever tool the reviewer used to produce the stated baseline (35/26/3/2/1) — it isn't part of this repo's tooling (checked `scripts/`, `package.json`; no mutation-testing dependency or script exists), and no new dependency could be added to install one (e.g. Stryker) per the lockfile constraint. I built an equivalent-purpose manual mutation pass instead: 13 targeted mutations against the exact code this fix round changed (`egress.ts`'s new classification/parsing logic, `guarded-fetch.ts`), applied one at a time, full `packages/integrations` suite run against each, then reverted. These are **not the reviewer's original 35 mutants** — a different, smaller, hand-picked set aimed at the same code. Reported honestly as such rather than mapped onto their numbers.

First pass (before two extra tests below were added): **12/13 killed, 1 survived.** Two of the "killed" results only held up because I stopped to check them:
- A first automated (Node `execSync`-based) attempt reported all 15 mutations tried as "killed" including several that manual spot-checking proved were **false positives** — `execSync`'s nested shell (`cmd.exe` on Windows) behaved differently from the Bash tool's own git-bash environment, corrupting every run identically (`errors.test.ts`, which imports neither changed file, "failed" on every single mutation, which is not possible for a real per-mutation effect). Discarded entirely; redone as a plain shell script (`sed` + the same Bash tool environment used throughout this task), with a write/readback check and immediate restore after every mutation.
- The first redirect-hop-skip mutation (see Important #2) revealed its "kill" was accidental (fake-fetch error, not guard error) — caught by manually reproducing it and reading the actual failure message rather than trusting a boolean pass/fail.

Two mutations survived on the real (corrected) run and were closed with new tests:
1. **Dropping `|| url.password !== ""` from the userinfo check** — every existing userinfo test set a non-empty *username*, so removing the password half of the check broke nothing. Verified empirically that `new URL("https://:secretpw@graph.facebook.com/")` gives `username=""`, `password="secretpw"` — a real, previously-untested code path. Added `refuses password-only userinfo (empty username) on an otherwise-legitimate host`.
2. **Allowing `http:` alongside `https:`** — every existing `"refuses http://…"` case (the plan's own base cases) also targets a private/internal host, so the *address* check still caught them even with the protocol check disabled; the protocol check itself was never isolated. Added `refuses a plain http:// request to an otherwise-legitimate, allowlisted host` (`http://graph.facebook.com/...`, which is legitimate in every respect except scheme).

Final run, 13 mutations, both fixes in place: **12 killed, 1 survived.** The one survivor — widening unique-local `fc00::/7` to `fc00::/6` — is over-broad, not under-broad (a /6 prefix matches a *superset* of what /7 matches), so it cannot create a bypass; it means no test currently pins the exact prefix length, which is a coverage-precision gap, not a security one. Left undecorated rather than adding a boundary-only test for a change that is safe in the direction it would actually go wrong.

### Minors

- **No port constraint** (`https://graph.facebook.com:22/` passes) — deliberately not fixing. The SSRF threat model here is about reaching *untrusted* infrastructure; once a host is confirmed on the allowlist it is trusted infrastructure by definition, and which port it listens on doesn't change that. Hardcoding `:443` would break legitimate non-default-port use (e.g. a sandboxed test server) for no corresponding security gain.
- **`IPV4_LITERAL` didn't range-check octets** (`999.999.999.999`) — fixed as a side effect of the classification rewrite above (Important #1); the old regex-based literal check no longer exists.
- **`fec0::/10`, `2001:db8::/32`, `100::/64`, `64:ff9b:1::/48` under-blocked** — fixed; all four added to `SIMPLE_BLOCKED_IPV6_PREFIXES` in `egress.ts`. Not currently exploitable via `assertEgressAllowed` (an IP literal never equals a domain name in `allowedHosts`, so the allowlist check already refuses them) but `assertResolvedAddressAllowed` is public and used standalone, where that backstop doesn't apply — cheap enough to close outright. `64:ff9b:1::/48` (RFC 8215 NAT64 *local-use*, distinct from the global well-known `64:ff9b::/96` already handled) is blocked as a whole range rather than having its embedded address extracted, since the embedding position within that /48 is operator-defined, not fixed by the RFC.

### Branded input type — decided against

Considered whether `assertResolvedAddressAllowed` should take a branded type (e.g. `ResolvedAddress`) instead of a bare `string`, to stop a caller passing an arbitrary raw string at the type level. Decided not to: a TypeScript brand only prevents *accidental* confusion for a caller who never explicitly casts; it does nothing against a caller who writes `x as ResolvedAddress` (trivial, and the exact failure mode this bug already was — passing a plain string where the function's real contract assumed more than the type expressed). The actual fix that matters for a security boundary is that the function's *runtime* behavior is fail-closed regardless of what shape of string arrives, which is what this fix round delivers. A brand adds ceremony at the one call site that matters (wrapping `dns.lookup`/`dns.resolve6` output) without closing any gap the runtime check doesn't already close, so it was left out.

### Existing tests modified

None, corrected. **Original framing was wrong and is corrected here (fix round 2):** the previous version of this report said "one existing test strengthened," referring to the first `guardedFetch` redirect test. `guarded-fetch.ts` and `guarded-fetch.test.ts` were both *created* in this same commit (`73b765c`, fix round 1) — there was no earlier commit in which that test existed to be "modified." The strengthening itself is real and stands as described (a bare `.rejects.toThrow()` was tightened to `.rejects.toThrow(/blocked|internal/i)` because mutation testing showed the bare assertion couldn't distinguish "the guard caught it" from "the fake fetch had no script entry and threw for an unrelated reason"), but it happened before the test was ever committed, so it is authoring, not modifying — no pre-existing test, anywhere in this package, was ever changed.

---

## Fix round 2 (independent re-review response)

Re-review of fix round 1's `guardedFetch` ran 42 adversarial redirect/URL-confusion scenarios (protocol-relative, `\`-prefixed, `javascript:`/`data:`/`file:`, downgrade, userinfo-in-`Location`, 6-hop and self-loop chains, a block at hop 5) with zero forbidden addresses reached, confirmed the `init`-override-proof ordering by mutant, and probed `assertResolvedAddressAllowed` with 36 further hostile forms (`0X7F000001`, `127.0x1`, `fe80::1%eth0`, `012.0.0.1`, `0b1111.0.0.1`, `4294967295`, `::FFFF:A9FE:A9FE`) — all closed, 13/13 legitimate addresses still allowed. Both fix-round-1 design decisions (no branded type, no port constraint) were judged correct. **Approved, one short fix round.**

### Important — the four fix-round-1 IPv6 ranges shipped with zero tests

`fec0::/10`, `2001:db8::/32`, `100::/64`, `64:ff9b:1::/48` were all correct and had all been manually probed by the reviewer, but nothing in the committed test suite pinned them — exactly the failure mode that let the original `assertResolvedAddressAllowed` bug happen (a real fix, silently reopened later because nothing proved it). Added one test per range in `egress.test.ts`, under `describe("IPv6 ranges added in fix round 1, now pinned individually")`.

**Fail-first proof** (mutation: delete each range's line from `SIMPLE_BLOCKED_IPV6_PREFIXES`, confirm only that range's test fails, restore):

```
--- delete fec0::/10 ---
 × ... refuses deprecated site-local fec0::/10
 Test Files  1 failed (1)   Tests  1 failed | 79 skipped (80)

--- delete 2001:db8::/32 ---
 × ... refuses the IPv6 documentation range 2001:db8::/32
 Test Files  1 failed (1)   Tests  1 failed | 79 skipped (80)

--- delete 100::/64 ---
 × ... refuses the discard-only range 100::/64
 Test Files  1 failed (1)   Tests  1 failed | 79 skipped (80)

--- delete 64:ff9b:1::/48 ---
 × ... refuses the NAT64 local-use range 64:ff9b:1::/48
 Test Files  1 failed (1)   Tests  1 failed | 79 skipped (80)
```

Each mutation failed exactly the one test targeting it and nothing else — clean, precise pinning.

### Minors, all addressed

**`maxRedirects: Infinity` / `NaN` unbind the redirect loop.** `hop >= Infinity` and `hop >= NaN` are both always false, so an invalid value doesn't create an SSRF (every hop is still guard-checked) but does hang the loop. Added an up-front `Number.isFinite(maxRedirects) || maxRedirects < 0` rejection in `guardedFetch`, before the first `fetch` call — same shape as `@smos/model-gateway`'s existing `!Number.isFinite(result.costUsd) || result.costUsd < 0` guard on provider-supplied numeric input (`packages/model-gateway/src/gateway.ts`), matched for consistency as the reviewer asked.

Real TDD here, not just a mutation-proof: the three new tests (`Infinity`, `-Infinity`, `NaN`) genuinely failed against the *unpatched* fix-round-1 code before this change existed:

```
× rejects maxRedirects: Infinity before ever calling fetch, instead of unbounding the loop
  → promise resolved "Response { status: 200, ... }" instead of rejecting
× rejects maxRedirects: -Infinity before ever calling fetch, instead of unbounding the loop
  → promise resolved "Response { status: 200, ... }" instead of rejecting
× rejects maxRedirects: NaN before ever calling fetch, instead of unbounding the loop
  → promise resolved "Response { status: 200, ... }" instead of rejecting
Tests  3 failed | 13 passed (16)
```

A fourth test (`maxRedirects: 0`) pins that 0 is still accepted as a legitimate "never follow redirects" value, so the fix isn't simply rejecting the boundary too.

**Relative and protocol-relative `Location` had no test.** Added three: a path-relative `Location` (`/new`) resolves and is re-checked; a protocol-relative `Location` (`//cdn.example.com/asset`) resolves to an allowlisted host and succeeds; the same form to `//169.254.169.254/...` is refused. The underlying resolution (`new URL(location, currentUrl)`) already handled both correctly — these are pinning tests, not a code change. **Fail-first proof:** mutating the resolution to drop the base argument (`new URL(location).href`) failed all three:

```
× resolves a path-relative Location against the current URL and re-checks the resolved form
× resolves a protocol-relative Location (//host/path) and allows it when the host is allowlisted
× refuses a protocol-relative Location (//host/path) when the host is forbidden -- the commonest real-world redirect form
Test Files  1 failed (1)   Tests  3 failed | 13 skipped (16)
```

**Over-large trailing octet (`127.99999999`) had no test.** This is a distinct code path from the already-tested `999.999.999.999` (that one fails the "any-but-last octet > 255" check; `127.99999999` only exercises the *last*-octet width check, `last >= maxLast`). Pinned because dropping that check turns a throw into a silently-computed address, which could be public-looking and therefore *allowed* — the worst direction a missing test can point. **Fail-first proof:** removing the `if (last >= maxLast) return null;` line:

```
× throws on an over-large trailing octet rather than silently wrapping it into some other address
Test Files  1 failed (1)   Tests  1 failed | 79 skipped (80)
```

**`fbff::1` boundary test, for the fix-round-1 surviving `fc00::/6` mutant.** Added `does not over-block: fbff::1 sits just below fc00::/7 and must stay allowed`, asserting `assertEgressAllowed` does NOT throw for it. As both the reviewer and I noted, this does not kill the specific `/6` mutant (fbff's top 6 bits, `111110`, differ from fc00's, `111111`, so a `/6` widening doesn't catch it either) — its purpose is proving the range as shipped isn't over-broad at this boundary, in either direction, not pinning the exact prefix length. **Fail-first proof** (a mutation that *would* catch it, to show the test can fail): broadening to `fc00::/3`:

```
× does not over-block: fbff::1 sits just below fc00::/7 and must stay allowed
Test Files  1 failed (1)   Tests  1 failed | 79 skipped (80)
```

**Duplicate `Location` headers had no test.** `Headers.get` joins repeated values with `", "` per the Fetch spec (verified empirically: two `Headers.append("location", ...)` calls produce `"https://a/x, https://b/y"` from `.get`). Confirmed this is not a bypass: `new URL(joined, currentUrl)` resolves the *whole* joined string as one URL, so its hostname is whichever value came first — the rest becomes an inert, percent-encoded path suffix (`https://graph.facebook.com/a,%20https://evil.test/b`, hostname `graph.facebook.com`). Added two tests recording this: first-value-allowed succeeds (against the real resolved URL, verified empirically before writing the test), first-value-forbidden is refused even if a later value would be allowed. Per the reviewer's instruction, the behavior itself was NOT changed — these tests exist so a future "helpful" rewrite (e.g. splitting on `,` and taking a different segment) has something to break. **Fail-first proof:** mutating the redirect-resolution to naively take the *last* comma-joined segment (`location.split(",").pop().trim()`) — a plausible-looking "fix" that is actually a real bypass direction, since it would let a blocked-first, allowed-second pair through:

```
× resolves to the FIRST duplicate value when it is allowed, treating the rest as an inert path suffix
× refuses when the FIRST duplicate value is forbidden, even if a later value would be allowed
Test Files  1 failed (1)   Tests  2 failed | 14 skipped (16)
```

### Mutation testing, final pass

Same caveat as fix round 1: no mutation-testing tool exists in this repo and none was added (lockfile constraint). Re-verified by hand, not trusted from the earlier automated script (which fix round 1's report already flagged as having produced false positives from a shell mismatch). One genuine flake was caught and re-verified during this round too: an initial scripted run of the `maxRedirects` finiteness mutation reported "no tests" (a malformed-run artifact, not a real result); manually reproducing the identical mutation and running it directly through the same Bash-tool git-bash environment used throughout this task gave a clean, correct result (3 failed, 1 passed, 12 skipped) — trusted the manual run, discarded the scripted one, exactly as fix round 1's process required.

**10 mutations targeted at every item in this round** (4 range deletions, the `/3` boundary broadening, the octet-width check, the `maxRedirects` finiteness check, the Location base-drop, the duplicate-Location last-segment take, and a re-check of fix round 1's redirect-bound off-by-one for regression): **10/10 killed**, each failing exactly the test(s) written for it and no others. Full suite green before and after every mutation was reverted (`packages/integrations`: 100/100 passing throughout).

### Test count

`packages/integrations`: 85 (end of fix round 1) → **100** (end of fix round 2): +6 pinning tests for the four IPv6 ranges and the `fbff::1`/octet boundaries in `egress.test.ts`, +9 in `guarded-fetch.test.ts` (3 `maxRedirects` non-finite + 1 `maxRedirects: 0` + 3 relative/protocol-relative `Location` + 2 duplicate-`Location`). All 100 pass; `typecheck`, `lint:secrets`, `lint:imports`, `lint:versions` all clean. No new dependency needed.

### Existing tests modified (fix round 2)

None. Every change this round either added a new test or added new, previously-missing validation code (`maxRedirects` finiteness) alongside its own new tests.

---

## Task 4 — Fake Meta server and typed adapter (E5)

Files: `packages/integrations/src/meta/fake-server.ts`, `src/meta/client.ts`, test `src/meta/contract.test.ts`. `src/index.ts` gained two export lines for the new public surface (`startFakeMetaServer`, `createMetaAdapter`).

### A necessary deviation from the plan's literal design, disclosed up front

The plan's own Task 4 example test used `allowedHosts: ["127.0.0.1"]` with a `baseUrl` implied to come from a real `node:http` listener ("fake-server.ts dùng node:http"). Both are incompatible with `assertEgressAllowed`/`assertResolvedAddressAllowed` as actually built and approved in Tasks 1-2: the guard requires `https:` unconditionally, and blocks the *entire* 127.0.0.0/8 loopback range unconditionally, **before it even consults `allowedHosts`**. A real server bound to `127.0.0.1`, reached through the (correctly) unweakened guard, cannot pass on any protocol -- the plan's own literal example would fail every single test, including the successful-publish one, if implemented as written.

Given the hard constraints (no real outbound network request ever, adapter must route every call through `guardedFetch`, no new dependency, guard must not be weakened), I did not stand up a real socket at all. `startFakeMetaServer()` is genuinely in-process -- exactly what the task brief explicitly permits ("a local in-process or localhost fake"). It returns a synthetic, domain-name-shaped base URL (`https://sandbox.meta.test`, using the IANA-reserved `.test` TLD, RFC 2606) that is never dialed, plus an injectable `fetchImpl: FetchLike` -- the exact same extension point `guardedFetch` itself already exposed in Task 2 ("`fetchImpl`... exists so tests can drive this with a local fake instead of a real socket"), just threaded one level up. `createMetaAdapter(cfg, fetchImpl = fetch)` takes `fetchImpl` as an additive, optional second parameter; production use (a real `baseUrl: "https://graph.facebook.com"`) never has to touch it and gets the real global `fetch`, unchanged. Because `sandbox.meta.test` is a domain name, not an IP literal, it takes the same "plain domain name, not checked" pass-through through `assertResolvedAddressAllowed` that a real `graph.facebook.com` call would -- so the https-only check, the userinfo check, and the allowlist check are all still genuinely exercised end to end; only the (intentionally out-of-scope, already-disclosed) IP-resolution check is a no-op, exactly as it would be for any real domain.

I considered standing up a real `node:https` listener with a self-signed certificate instead (empirically verified this works when `NODE_EXTRA_CA_CERTS` is set *before* the Node process starts -- confirmed with a throwaway script and `openssl`-generated cert/key) and rejected it: it only works if the test *launcher* sets that env var externally (setting it mid-process, after Node has already bootstrapped its TLS trust store, verifiably does **not** work -- I confirmed this fails with `self-signed certificate` before finding the working form), which is a fragile, undocumented precondition on however `vitest` gets invoked later. The in-process design has no such precondition and is structurally incapable of a real network call, which is a stronger guarantee for a "never touches the network" requirement than "we remembered to disable cert checking correctly."

### TDD evidence

**Failing run** (before `fake-server.ts`/`client.ts` existed):
```
Cannot find module './fake-server.ts' imported from D:/MA-p4/packages/integrations/src/meta/contract.test.ts
Test Files  1 failed (1)
     Tests  no tests
```

**Passing run after first implementation:** 18/18 (`npx vitest run packages/integrations/src/meta/contract.test.ts`).

**Two more failing-first rounds during adversarial self-review** (see below), both fixed:
1. A malformed `Retry-After` header (`"not-a-number"`) produced `retryAfterMs: NaN` on an `AdapterError`:
   ```
   AssertionError: expected NaN to be undefined
     at contract.test.ts:225:48
   ```
   Fixed by requiring `Number.isFinite(retryAfterSeconds)` before setting `retryAfterMs` at all (`client.ts`), rather than ever emitting NaN as a "retry hint" a downstream scheduler (Task 5, out of scope here) could misread as "retry immediately, forever."
2. A distinctly-*invalid* (not merely expired) token silently succeeded instead of failing:
   ```
   Error: promise resolved "{ externalId: 'page-1_1', ... }" instead of rejecting
     at contract.test.ts:96:44
   ```
   Fixed by adding a `token === "invalid"` (and empty-token) branch in `fake-server.ts` alongside `"expired"`, both mapping to the same real-world OAuthException 190 / `auth_expired`, since Meta's wire format has no separate signal to distinguish "expired" from "never valid."

**Final run:** `packages/integrations` full suite (`egress.test.ts`, `errors.test.ts`, `guarded-fetch.test.ts`, `meta/contract.test.ts`): **120/120 passing**, 25/25 test files, across 4 files. `npx tsc --noEmit -p packages/integrations/tsconfig.json`: **no errors** (two `exactOptionalPropertyTypes` errors found and fixed along the way -- `body: string | undefined` and `retryAfterMs: number | undefined` both needed to be *omitted* rather than explicitly set to `undefined`, since the target types don't accept the widened form under this repo's strict tsconfig).

Non-DB static gates re-run against the final, staged state: `lint:imports` (109 files, ok), `lint:secrets` (150 files, ok), `lint:scope` (220 files, ok), `lint:versions` (12 manifests, ok), `lint:purity` (17 files, ok), `lint:migrations` (28 files, ok). `npm run verify` was **not** run (forbidden by this task's brief -- shared PostgreSQL on port 5433 across three concurrent worktrees).

### Full error-response -> `ERROR_KINDS` mapping table

| Scenario | HTTP status | Graph-shaped error | `ErrorKind` | `retryable` | Notes |
|---|---|---|---|---|---|
| Successful publish | 200 | `{ id, requestId }` | -- | -- | Idempotency-keyed replay returns the same `id`, never creates a second post |
| Rate limited, with retry hint | 429 | `error.code 4`, `type OAuthException`, `Retry-After: 5` header | `rate_limited` | **true** | `retryAfterMs = 5000`, taken from the header |
| Rate limited, malformed hint | 429 | same, `Retry-After: not-a-number` | `rate_limited` | **true** | `retryAfterMs` **omitted**, never `NaN` (fixed during self-review) |
| Expired token | 401 | `error.code 190`, `type OAuthException`, token echoed into message | `auth_expired` | false | Message deliberately echoes the raw token (realistic Meta behaviour, see `errors.ts`) to exercise redaction for real |
| Invalid (never-valid) token | 401 | same code 190 | `auth_expired` | false | No separate wire signal for "invalid" vs "expired" in real Meta; both map the same way |
| Blank/whitespace-only content | 400 | `error.code 100`, `type GraphMethodException` | `invalid_input` | false | Checked after auth/account routing, before any post is created |
| Quota/spend limit reached | 403 | `error.code 80004`, `type OAuthException` | `quota_exceeded` | false | |
| Transient upstream outage | 503 | `error.code 2`, `type OAuthException` | `upstream_unavailable` | **true** | Any `>= 500` maps the same way |
| Malformed / non-JSON body | 200 (misleading `content-type: application/json`, unparseable text) | -- | `upstream_unavailable` | **true** | Never read as a fake success; JSON-parse failure short-circuits before the `response.ok` check even runs |
| Slow response / timeout | (never arrives within `timeoutMs`) | -- | `upstream_unavailable` | **true** | Adapter-side `AbortSignal.timeout`; fake server delays 200ms, test uses `timeoutMs: 20` and asserts total wall time `< 150ms`, proving the timeout -- not luck -- won the race |
| Redirect to a blocked/internal address | 302, `Location: https://169.254.169.254/...` | -- | `permanent_rejection` | false | Never followed: `guardedFetch` re-runs the full guard on the `Location` header and throws before a second `fetchImpl` call is made (proved via a call-counter: exactly 1 call) |
| Any other non-2xx (e.g. object not found) | 404 | `error.code 100`, `type GraphMethodException` | `permanent_rejection` | false | Catch-all: nothing about a 404 is "wait and retry" or "fix input and resubmit" |
| Host not on `allowedHosts` | (never sent) | -- | `permanent_rejection` (wrapped from the guard's own `Error`) | false | Guard throws before any `fetchImpl` call (0 calls, proved) |
| Downgraded `http://` baseUrl | (never sent) | -- | `permanent_rejection` (wrapped) | false | Guard's protocol check throws before any `fetchImpl` call (0 calls, proved) |

### Adversarial self-review attempts and outcomes

| Attempt | Outcome |
|---|---|
| Contact a host not on `allowedHosts` | **Blocked.** `assertEgressAllowed`'s allowlist check throws before `guardedFetch` ever calls `fetchImpl`; instrumented with a call-counting `fetchImpl` wrapper and asserted `calls === 0`. |
| Follow a redirect (`page-redirect-trap`, `Location: https://169.254.169.254/...`) to a blocked, cloud-metadata-shaped address | **Blocked.** `guardedFetch` re-runs the full guard on the resolved `Location` before ever calling `fetchImpl` a second time; call-counter proves exactly 1 call was made (the initial request that returned the 302), never a second one to the forbidden address. |
| Downgrade to `http://` on an otherwise-legitimate, allowlisted host | **Blocked.** Protocol check in `assertEgressAllowed` runs first and throws before any `fetchImpl` call; 0 calls proved. |
| Make the adapter retry a retryable-kind failure (`rate_limited`) on its own | **Confirmed it never does.** `publish()` makes exactly one `callGraph` call, which makes exactly one `guardedFetch`/`fetchImpl` call; instrumented and asserted `calls === 1` even though the resulting error is `retryable: true`. `retryable` is a hint for a caller's retry policy (Task 5, out of scope here), never permission for the adapter itself to retry -- matches the plan's own global constraint ("Publish thất bại ⇒ failed, không auto-retry với side effect ra ngoài"). |
| Surface a secret in an error path | **No leak, proven against a message that actually contained one.** Forced a deterministic error (`page-rate-limited`, always 429s regardless of token) with a secret-shaped token (`EAAsupersecretvalue...`) that the fake server echoes into its raw error message (realistic Meta behaviour). Asserted `err.message` **does** contain the secret (proving the redaction had real work to do, not that there was nothing to redact) and `err.safeMessage` does **not**. |
| Surface a secret in a successful publish's evidence | **No leak.** Successful publish with a secret-shaped token; asserted `JSON.stringify(result.evidence)` never contains it -- `evidence` only ever carries `{ requestId, status }`, both server-generated, never echoing `cfg.token`. |
| Surface a secret via a log line | **Not applicable / no leak by construction.** Neither `client.ts` nor `fake-server.ts` calls any logger; the only place `cfg.token` is ever placed is the `Authorization` request header (never read back into an error message by the client itself) and, in the fake server's deliberately-adversarial echo scenarios, the response body text -- which flows into `AdapterError`'s constructor exactly like any other provider message and is redacted the same way. |
| Manufacture a `NaN` retry hint via a malformed `Retry-After` header | **Found by self-review, fixed with a failing test first** (see TDD evidence above). `retryAfterMs` is now omitted rather than set to `NaN` when the header doesn't parse to a finite number. |
| Get a fake success out of a non-JSON 200 response | **Blocked.** `page-malformed` returns `200` with `content-type: application/json` but an unparseable body; `JSON.parse` failure throws `upstream_unavailable` before the `response.ok` short-circuit is ever reached, so a `200` status alone cannot produce a `PublishResult`. |
| Get a fake success with no `id` in an otherwise-well-formed 200 response | **Blocked by construction, not separately tested.** `publish()` explicitly checks `typeof record?.id !== "string" || record.id === ""` and throws `upstream_unavailable` rather than returning `externalId: undefined`. Every scripted success path in the fake server always sets `id`, so this exact branch isn't exercised by the committed suite -- disclosed as untested-but-present defensive code, not a gap in the adapter's own guarantee. |

### Boundaries intentionally left to Task 5 (out of scope here)

- **Approval gating.** The plan's global constraint ("Adapter không được gọi nếu thiếu `ApprovalDecision` hoặc hash nội dung lệch bản đã duyệt") is a caller-side responsibility. `ChannelAdapter.publish` takes `contentHash` as an opaque string in `PublishInput` and never checks it against a stored approved hash -- it has no access to approval state at all. This must be enforced by Task 5's publish handler before it ever calls `adapter.publish(...)`, per the plan's own File Structure Map (`apps/worker/src/handlers/publish.ts` owns `handlePublish`).
- **No auto-retry with side effects.** Confirmed above that the adapter itself never retries; a retry policy acting on `retryable`/`retryAfterMs` is Task 5's job.
- **DNS rebinding and single-hop redirect scope.** Both are the same accepted, disclosed gaps from Tasks 1-2's egress guard (CARRY-FORWARD.md) -- this adapter does not attempt to close them, and doesn't need to for the in-process fake, since no real DNS resolution or real redirect ever happens here.

### Existing tests modified

None. No file outside `packages/integrations/src/meta/` and the two new export lines in `packages/integrations/src/index.ts` was touched. No existing test in the repository was weakened, deleted, or had its assertions loosened.

### Task 3 (database)

Not touched, and not needed. `createMetaAdapter`/`startFakeMetaServer` never import `@smos/db`, never reference `integration`/`credential_reference`/`event`/`metric`, and never open a PostgreSQL connection. Nothing in Task 4 required the tables Task 3 owns.

### New dependencies

None. Everything used (`fetch`, `Response`, `Headers`, `URL`, `DOMException`, `AbortSignal.timeout`) is a Node/web-platform global already relied on by Tasks 1-2's own code (`guarded-fetch.ts`, `guarded-fetch.test.ts`). `package.json`/`package-lock.json` are untouched (verified with `git diff --stat`).

### Uncertain / worth a second look

- The plan's literal Task 4 test fixture (`allowedHosts: ["127.0.0.1"]`, implied real `node:http` server) cannot work against the guard as actually built, for reasons explained above. Whoever wrote or reviews the plan against the delivered guard should confirm this deviation (in-process fake, domain-name-shaped synthetic host, injectable `fetchImpl`) is the intended resolution, not just a implementer's workaround.
- `createMetaAdapter`'s `fetchImpl` parameter is a new, adapter-level injection point (distinct from `guardedFetch`'s own, which it wraps). If a later task wires this adapter into `apps/worker`, the production call site should simply omit the second argument (defaults to real `fetch`) -- flagging so nobody accidentally wires the fake in outside tests.
- The "no `id` in an otherwise-200 response" defensive branch in `publish()` is untested (see adversarial table above) -- every fake-server success path always sets `id`, so nothing in the committed suite exercises that specific line. Low risk (fails closed to `upstream_unavailable` either way) but noted for completeness.
