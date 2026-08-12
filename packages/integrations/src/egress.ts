/**
 * Blocks SSRF (threat T8): an agent that can be talked into fetching an
 * attacker-chosen URL must never reach loopback, private, link-local, or
 * cloud-metadata addresses, no matter how the address is spelled.
 *
 * This is a pure, synchronous string check -- it never opens a socket and
 * never does DNS resolution. Two consequences follow, and both are
 * deliberate rather than accidental gaps:
 *
 * 1. DNS rebinding is NOT caught here. A hostname that resolves to a
 *    private address only at connect time (after this check has already
 *    passed) will not be detected by this function. Closing that gap
 *    requires resolving DNS and pinning the resolved address before
 *    connecting -- out of scope for a synchronous URL check. A caller that
 *    needs that guarantee should resolve the hostname itself and re-run
 *    the *same* private-address logic against the resolved literal (see
 *    `assertResolvedAddressAllowed`, exported below for exactly that
 *    reuse), then connect only to the address it just checked -- never
 *    re-resolve after validating.
 *
 * 2. This function inspects exactly one URL and has no HTTP client, so it
 *    cannot see a redirect. A permitted host that answers 30x with a
 *    forbidden `Location` is a real bypass if the caller blindly follows
 *    it. Callers MUST disable automatic redirect following (e.g. `fetch`
 *    with `redirect: "manual"`) and call `assertEgressAllowed` again on
 *    every `Location` header before following it -- this module only
 *    guards a single hop.
 *
 * Always fetch the exact `rawUrl` string passed in here (or
 * `new URL(rawUrl).href`, which is equivalent) -- never a URL rebuilt from
 * parts of it -- so the HTTP client's idea of "host" cannot diverge from
 * this function's. This module always parses with the WHATWG `URL`
 * constructor, the same algorithm Node's `fetch`/undici use internally, so
 * there is no parser mismatch as long as callers respect that rule.
 */
export function assertEgressAllowed(rawUrl: string, allowedHosts: readonly string[]): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`Only https egress is permitted, got ${url.protocol}`);
  }

  if (url.username !== "" || url.password !== "") {
    // Classic SSRF confusion vector: http://allowed-looking@evil-host/.
    // WHATWG URL already resolves .hostname to the real connect target
    // (verified: url.hostname is evil-host here, never the userinfo), so
    // this alone cannot bypass the allowlist check below -- but there is
    // no legitimate reason for a channel-adapter call to carry credentials
    // in the URL, and refusing it outright removes the whole class rather
    // than relying on every future caller building the request correctly.
    throw new Error("Egress URLs must not carry userinfo (credentials-in-URL)");
  }

  assertResolvedAddressAllowed(url.hostname);

  if (!allowedHosts.includes(url.hostname)) {
    throw new Error(`Host ${url.hostname} is not on the egress allowlist`);
  }
}

/**
 * Checks a single already-resolved hostname or IP literal against the
 * private/internal address space. Exported so a caller that performs its
 * own DNS resolution (to close the rebinding gap described above) can pin
 * the resolved address and re-validate it with the exact same rules this
 * module applies to URL hostnames.
 *
 * FIX ROUND 1: this used to require IPv6 to be bracketed and IPv4 to
 * already be canonical dotted-decimal, silently falling through to "must
 * be a domain name, not checked" for anything else -- which meant every
 * unbracketed IPv6 address (exactly what `dns.resolve6` returns) and every
 * non-canonical IPv4 encoding, called directly rather than through
 * `assertEgressAllowed`'s `URL` parse, passed through unchecked. Fixed by
 * classifying input the same way a real host parser does, independent of
 * bracket/canonical-form assumptions, and failing closed (throwing) on
 * anything that looks like an address attempt but doesn't parse -- instead
 * of assuming "not a form I recognise" means "safe to treat as a domain".
 *
 * Classification, in order:
 *   1. "localhost" / "*.localhost" -- blocked by name.
 *   2. Contains a ":" -- an IPv6 attempt (bracketed or not; a domain name
 *      or IPv4 address never contains a colon). Parsed and range-checked;
 *      throws if it doesn't parse.
 *   3. "Ends in a number" (mirrors the WHATWG URL host parser's own rule:
 *      the last "."-separated label is decimal/octal/hex-number-shaped)
 *      -- an IPv4 attempt, all or nothing. Parsed with the same
 *      decimal/octal/hex/mixed-shorthand algorithm the URL spec uses, so
 *      "2130706433", "0x7f000001", "127.1" and "0177.0.0.1" are all
 *      recognised without ever going through `URL`. Throws if the parse
 *      fails (e.g. an out-of-range octet like "999.999.999.999") rather
 *      than falling through.
 *   4. Anything else is a plain domain name -- not resolved, not checked
 *      here; see the DNS-rebinding note on `assertEgressAllowed`. This is
 *      the one intentional pass-through, and it is a domain name, never
 *      something IP-shaped that failed to parse.
 */
export function assertResolvedAddressAllowed(hostname: string): void {
  // A trailing dot denotes the same FQDN either way; strip it once up
  // front so IPv6/IPv4/domain classification below doesn't have to special
  // case it three times.
  const lower = hostname.toLowerCase().replace(/\.$/, "");

  if (lower === "localhost" || lower.endsWith(".localhost")) {
    throw new Error("Egress to localhost is blocked");
  }

  if (lower.includes(":")) {
    const stripped = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
    assertIPv6AddressAllowed(stripped);
    return;
  }

  if (endsInANumber(lower)) {
    assertIPv4AddressAllowed(lower);
    return;
  }

  // Not IPv6-shaped (no colon) and does not end in a number: a plain
  // domain name. Its resolved address is out of scope for this
  // synchronous check.
}

/**
 * Mirrors the WHATWG URL Standard's "ends in a number" host-classification
 * rule: split on ".", and if the last non-empty label is itself a valid
 * IPv4-number token (decimal, "0x"/"0X" hex, or leading-zero octal), the
 * *whole* host is an IPv4-parse attempt -- never reinterpreted as a domain
 * name even if that attempt then fails. This is what makes "999.999.999.999"
 * throw instead of silently passing as an unrecognised domain: its last
 * label "999" is decimal-shaped, so the full parse runs and fails on the
 * out-of-range earlier octet.
 */
function endsInANumber(host: string): boolean {
  const parts = host.split(".");
  const last = parts[parts.length - 1] ?? "";
  if (last === "") return false;
  return parseIPv4Part(last) !== null;
}

/**
 * Parses one "."-separated IPv4 label per the WHATWG URL IPv4-number
 * grammar: "0x"/"0X" prefix -> hex, leading "0" (length >= 2) -> octal,
 * otherwise decimal. Requires the ENTIRE remaining string to be valid
 * digits for that base (no partial parse a la `parseInt`) -- "12abc" is a
 * failure, not 12.
 */
function parseIPv4Part(part: string): number | null {
  if (part === "") return null;
  let radix = 10;
  let digits = part;
  if (part.length >= 2 && (part[0] === "0") && (part[1] === "x" || part[1] === "X")) {
    radix = 16;
    digits = part.slice(2);
  } else if (part.length >= 2 && part[0] === "0") {
    radix = 8;
    digits = part.slice(1);
  }
  if (digits === "") return 0;
  const valid = radix === 16 ? /^[0-9a-fA-F]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!valid.test(digits)) return null;
  const value = parseInt(digits, radix);
  return Number.isFinite(value) ? value : null;
}

/**
 * Full WHATWG URL IPv4-parsing algorithm: up to four "."-separated parts,
 * each parsed per `parseIPv4Part`, with the mixed-shorthand rule where a
 * host with fewer than four parts packs the last part into the remaining
 * low-order bits (so "127.1" -> 127.0.0.1, "2130706433" alone -> the same
 * address as a raw 32-bit value). Returns null -- fail closed -- for
 * anything that doesn't fit: too many parts, an empty part (e.g. a
 * doubled or trailing "."), a non-last part over 255, or a last part that
 * doesn't fit in the bits the earlier parts left it.
 */
function parseIPv4Address(host: string): number | null {
  const parts = host.split(".");
  if (parts.length > 4) return null;
  if (parts.some((p) => p === "")) return null;

  const numbers: number[] = [];
  for (const part of parts) {
    const n = parseIPv4Part(part);
    if (n === null) return null;
    numbers.push(n);
  }

  for (let i = 0; i < numbers.length - 1; i++) {
    if ((numbers[i] ?? 0) > 255) return null;
  }

  const last = numbers[numbers.length - 1] ?? 0;
  const maxLast = 256 ** (5 - numbers.length);
  if (last >= maxLast) return null;

  let ipv4 = last;
  numbers.pop();
  for (let i = 0; i < numbers.length; i++) {
    ipv4 += (numbers[i] ?? 0) * 256 ** (3 - i);
  }
  return ipv4;
}

function v4(a: number, b: number, c: number, d: number): number {
  return a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d;
}

function intToDotted(n: number): string {
  const a = (n >>> 24) & 255;
  const b = (n >>> 16) & 255;
  const c = (n >>> 8) & 255;
  const d = n & 255;
  return `${a}.${b}.${c}.${d}`;
}

// Every IANA special-purpose IPv4 range that must never be reached from an
// agent-controlled URL: "this network", loopback, RFC1918 private space,
// CGNAT, link-local (which is where 169.254.169.254 -- the cloud metadata
// endpoint shared by AWS/GCP/Azure -- lives), documentation/test ranges,
// benchmarking space, multicast, and reserved/broadcast.
const IPV4_BLOCKED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [v4(0, 0, 0, 0), v4(0, 255, 255, 255)], // 0.0.0.0/8
  [v4(10, 0, 0, 0), v4(10, 255, 255, 255)], // 10.0.0.0/8
  [v4(100, 64, 0, 0), v4(100, 127, 255, 255)], // 100.64.0.0/10 CGNAT
  [v4(127, 0, 0, 0), v4(127, 255, 255, 255)], // 127.0.0.0/8 loopback
  [v4(169, 254, 0, 0), v4(169, 254, 255, 255)], // 169.254.0.0/16 link-local + metadata
  [v4(172, 16, 0, 0), v4(172, 31, 255, 255)], // 172.16.0.0/12
  [v4(192, 0, 0, 0), v4(192, 0, 0, 255)], // 192.0.0.0/24 IETF protocol assignments
  [v4(192, 0, 2, 0), v4(192, 0, 2, 255)], // 192.0.2.0/24 TEST-NET-1
  [v4(192, 168, 0, 0), v4(192, 168, 255, 255)], // 192.168.0.0/16
  [v4(198, 18, 0, 0), v4(198, 19, 255, 255)], // 198.18.0.0/15 benchmarking
  [v4(198, 51, 100, 0), v4(198, 51, 100, 255)], // 198.51.100.0/24 TEST-NET-2
  [v4(203, 0, 113, 0), v4(203, 0, 113, 255)], // 203.0.113.0/24 TEST-NET-3
  [v4(224, 0, 0, 0), v4(255, 255, 255, 255)], // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
];

function isBlockedIPv4Int(n: number): boolean {
  return IPV4_BLOCKED_RANGES.some(([start, end]) => n >= start && n <= end);
}

function assertIPv4AddressAllowed(raw: string): void {
  const n = parseIPv4Address(raw);
  if (n === null) {
    // Fail closed: this was classified as an IPv4-parse attempt (it "ends
    // in a number"), so a failed parse is a malformed address, not a
    // reason to fall back to treating it as a domain name.
    throw new Error(`Malformed IPv4 address: ${raw}`);
  }
  if (isBlockedIPv4Int(n)) {
    throw new Error(`Egress to internal address ${raw} (${intToDotted(n)}) is blocked`);
  }
}

/**
 * Parses an IPv6 address (without brackets) into its 128-bit value.
 * Accepts the pure hex-group form the WHATWG URL parser always produces
 * (e.g. "::1", "fd00:ec2::254", "::ffff:7f00:1") and, defensively, a
 * trailing dotted-quad mixed form ("::ffff:127.0.0.1") in case this
 * function is ever called on a string that did not come through our own
 * `new URL()` parse. Returns null for anything malformed -- callers must
 * treat that as fail-closed (blocked), never as fail-open.
 */
function parseIPv6(addr: string): bigint | null {
  let body = addr;

  const dottedMatch = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(body);
  if (dottedMatch) {
    const prefix = dottedMatch[1] ?? "";
    const quad = dottedMatch[2] ?? "";
    const octets = quad.split(".").map(Number);
    if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null;
    const [o0, o1, o2, o3] = octets;
    const hi = (((o0 ?? 0) << 8) | (o1 ?? 0)).toString(16);
    const lo = (((o2 ?? 0) << 8) | (o3 ?? 0)).toString(16);
    body = `${prefix}${hi}:${lo}`;
  }

  const halves = body.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (s: string): number[] => (s === "" ? [] : s.split(":").map((g) => parseInt(g, 16)));

  let groups: number[];
  if (halves.length === 2) {
    const left = parseGroups(halves[0] ?? "");
    const right = parseGroups(halves[1] ?? "");
    if (left.some(Number.isNaN) || right.some(Number.isNaN)) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...new Array(missing).fill(0), ...right];
  } else {
    groups = parseGroups(body);
  }

  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;

  let value = 0n;
  for (const g of groups) value = (value << 16n) | BigInt(g);
  return value;
}

function ipv6HasPrefix(value: bigint, prefixText: string, prefixLen: number): boolean {
  const prefixValue = parseIPv6(prefixText);
  if (prefixValue === null) return false;
  const shift = 128n - BigInt(prefixLen);
  return value >> shift === prefixValue >> shift;
}

// Ranges that are blocked outright, regardless of what they embed.
// fec0::/10, 2001:db8::/32 and 100::/64 below were flagged as under-blocked
// in review round 1: not currently exploitable (an IP literal never equals
// a domain name in `allowedHosts`, so `assertEgressAllowed` already refuses
// them via the allowlist check), but `assertResolvedAddressAllowed` is
// public and used standalone, where that backstop doesn't apply -- cheap to
// close outright rather than rely on a second layer.
const SIMPLE_BLOCKED_IPV6_PREFIXES: ReadonlyArray<readonly [string, number]> = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["fc00::", 7], // unique local (fc00::/7 covers fd00::/8, incl. AWS's fd00:ec2::254)
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["fec0::", 10], // deprecated site-local (RFC 3879) -- superseded by fc00::/7 but still seen
  ["2001:db8::", 32], // IPv6 documentation range (the v6 analogue of TEST-NET)
  ["100::", 64], // discard-only address block (RFC 6666)
  ["64:ff9b:1::", 48], // NAT64 *local-use* prefix (RFC 8215) -- distinct from the global
  // well-known 64:ff9b::/96 already handled below; the embedded-address
  // position within this /48 is operator-defined, not fixed, so the whole
  // block is refused outright rather than attempting extraction.
];

// Transition mechanisms that embed a literal IPv4 address in the low bits
// (IPv4-mapped, NAT64 well-known prefix) or a fixed offset (6to4). A
// private IPv4 reachable this way is exactly as dangerous as reaching it
// directly, so the embedded address is extracted and re-checked with the
// same IPv4 range table.
const EMBEDDING_IPV6_PREFIXES: ReadonlyArray<readonly [string, number]> = [
  ["::ffff:0:0", 96], // IPv4-mapped
  ["64:ff9b::", 96], // NAT64 well-known prefix
  ["2002::", 16], // 6to4
  ["::", 96], // deprecated IPv4-compatible (e.g. "::127.0.0.1" -> [::7f00:1]).
  // Distinct from ::ffff:0:0/96 above: this matches only when bits 80-95
  // are NOT 0xffff (an address can't satisfy both prefixes at once), so
  // there is no double-handling of the same address.
];

function extractEmbeddedIPv4(value: bigint, prefixLen: number): number | null {
  if (prefixLen === 96) return Number(value & 0xffffffffn);
  if (prefixLen === 16) return Number((value >> 80n) & 0xffffffffn); // 2002:AABB:CCDD::/16 -> bits 16..47
  return null;
}

function assertIPv6AddressAllowed(addr: string): void {
  const value = parseIPv6(addr);
  if (value === null) {
    // Fail closed: an address this function cannot parse is not one it can
    // vouch for as safe.
    throw new Error(`Malformed IPv6 address: ${addr}`);
  }

  for (const [prefixText, len] of SIMPLE_BLOCKED_IPV6_PREFIXES) {
    if (ipv6HasPrefix(value, prefixText, len)) {
      throw new Error(`Egress to internal IPv6 address [${addr}] is blocked (matches ${prefixText}/${len})`);
    }
  }

  for (const [prefixText, len] of EMBEDDING_IPV6_PREFIXES) {
    if (ipv6HasPrefix(value, prefixText, len)) {
      const embedded = extractEmbeddedIPv4(value, len);
      if (embedded !== null && isBlockedIPv4Int(embedded)) {
        throw new Error(
          `Egress to internal IPv6 address [${addr}] is blocked (embeds ${intToDotted(embedded)} via ${prefixText}/${len})`,
        );
      }
    }
  }
}
