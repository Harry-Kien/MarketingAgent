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
 * A plain domain name (anything that is not "localhost", an IPv4 literal,
 * or a bracketed IPv6 literal) is not resolved and not checked here -- see
 * the DNS-rebinding note on `assertEgressAllowed`.
 *
 * Expects an already-canonical address: plain dotted-decimal IPv4 (what
 * Node's `dns`/`net` modules and WHATWG `URL` both produce) or a bracketed
 * IPv6 literal. It does NOT itself re-interpret decimal/octal/hex IPv4
 * encodings ("2130706433", "0x7f000001", ...) -- that canonicalization is
 * done for `assertEgressAllowed` by the `URL` constructor before this
 * function ever sees the hostname. A caller feeding this function a raw,
 * un-canonicalized numeric string bypasses that protection.
 */
export function assertResolvedAddressAllowed(hostname: string): void {
  const lower = hostname.toLowerCase();

  if (lower === "localhost" || lower.endsWith(".localhost")) {
    throw new Error("Egress to localhost is blocked");
  }

  if (lower.startsWith("[") && lower.endsWith("]")) {
    assertIPv6AddressAllowed(lower.slice(1, -1));
    return;
  }

  if (IPV4_LITERAL.test(lower)) {
    assertIPv4AddressAllowed(lower);
    return;
  }

  // Not a recognizable IP literal: a plain domain name. Its resolved
  // address is out of scope for this synchronous check.
}

const IPV4_LITERAL = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function v4(a: number, b: number, c: number, d: number): number {
  return a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d;
}

function ipv4ToInt(dotted: string): number {
  const [a, b, c, d] = dotted.split(".").map(Number);
  return v4(a ?? 0, b ?? 0, c ?? 0, d ?? 0);
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

function assertIPv4AddressAllowed(dotted: string): void {
  const n = ipv4ToInt(dotted);
  if (isBlockedIPv4Int(n)) {
    throw new Error(`Egress to internal address ${dotted} is blocked`);
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
const SIMPLE_BLOCKED_IPV6_PREFIXES: ReadonlyArray<readonly [string, number]> = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["fc00::", 7], // unique local (fc00::/7 covers fd00::/8, incl. AWS's fd00:ec2::254)
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
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
