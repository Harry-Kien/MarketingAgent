import { describe, expect, it } from "vitest";
import { assertEgressAllowed, assertResolvedAddressAllowed } from "./egress.ts";

const ALLOW = ["graph.facebook.com"];

// --- Fix round 1: assertResolvedAddressAllowed must fail closed --------
// Reviewer measurement: called directly (as a future DNS-rebinding-closing
// caller would, with what dns.lookup/dns.resolve6 actually return -- always
// unbracketed), it silently let every one of these through. dns.resolve6
// never returns brackets, and dns.lookup never returns decimal/octal/hex
// IPv4, so this is exactly the input shape the function exists to handle.
describe("assertResolvedAddressAllowed (direct calls, not via assertEgressAllowed)", () => {
  describe("unbracketed IPv6 -- what dns.resolve6 actually returns", () => {
    it.each(["::1", "fd00:ec2::254", "fe80::1", "::ffff:127.0.0.1"])("throws for unbracketed %s", (addr) => {
      expect(() => assertResolvedAddressAllowed(addr)).toThrow();
    });
  });

  describe("non-canonical IPv4 encodings, called directly without going through URL", () => {
    it.each(["2130706433", "0x7f000001", "127.1", "0177.0.0.1"])("throws for %s", (addr) => {
      expect(() => assertResolvedAddressAllowed(addr)).toThrow();
    });
  });

  describe("fails closed on malformed IP-shaped input instead of silently treating it as a domain", () => {
    it.each([
      "999.999.999.999", // ends in a number -> IPv4 parse attempt -> out-of-range octet
      "300.1.2.3", // same: first octet > 255
      "1.2.3.4.5", // too many parts to be IPv4, but the last part is numeric
      "::1::2", // two "::" compressions -- not valid IPv6
      "fe80::zzzz", // contains a colon -- must be treated as an IPv6 attempt, and "zzzz" isn't hex
    ])("throws for %s rather than returning silently", (addr) => {
      expect(() => assertResolvedAddressAllowed(addr)).toThrow();
    });
  });

  it("still passes through a genuine domain name unchecked (not simply refusing everything)", () => {
    expect(() => assertResolvedAddressAllowed("graph.facebook.com")).not.toThrow();
  });

  it("still allows a public IPv4 the same way it always did (no regression)", () => {
    expect(() => assertResolvedAddressAllowed("8.8.8.8")).not.toThrow();
  });

  // Fix round 2: distinct code path from "999.999.999.999" above (that one
  // fails the "any-but-last octet > 255" check). This exercises the
  // *last*-octet width check (`last >= maxLast`) instead. Reviewer's
  // framing: if this check were missing, the shorthand-notation arithmetic
  // would still produce *some* 32-bit value from "127.99999999" -- turning
  // a malformed address into a silently-computed, possibly-public-looking
  // one, i.e. a throw becomes an ALLOWED address. That is the worst
  // direction a missing test can point, so it is pinned on its own.
  it("throws on an over-large trailing octet rather than silently wrapping it into some other address", () => {
    expect(() => assertResolvedAddressAllowed("127.99999999")).toThrow();
  });

  it("blocks a loopback IPv4 written with a trailing FQDN dot, not just the bare form", () => {
    // Without stripping the trailing dot first, splitting "127.0.0.1." on
    // "." yields a final empty label, "ends in a number" sees an empty
    // last part and returns false, and the whole address would silently
    // fall through as an unrecognised "domain name".
    expect(() => assertResolvedAddressAllowed("127.0.0.1.")).toThrow();
  });
});

describe("assertEgressAllowed", () => {
  // --- Plan's base cases, verbatim -------------------------------------
  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:5432/",
    "http://localhost/admin",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://[::1]/",
    "file:///etc/passwd",
  ])("refuses %s", (url) => {
    expect(() => assertEgressAllowed(url, ALLOW)).toThrow();
  });

  it("allows an allowlisted host over https", () => {
    expect(() => assertEgressAllowed("https://graph.facebook.com/v23.0/me", ALLOW)).not.toThrow();
  });

  it("refuses a host that is not on the allowlist", () => {
    expect(() => assertEgressAllowed("https://evil.test/", ALLOW)).toThrow(/allowlist/i);
  });

  it("refuses a lookalike subdomain", () => {
    expect(() => assertEgressAllowed("https://graph.facebook.com.evil.test/", ALLOW)).toThrow(/allowlist/i);
  });

  // Fix round 1, mutation-testing finding: every existing "refuses http://"
  // case above also has a private/internal host, so disabling the protocol
  // check entirely still left them blocked by the address check -- the
  // mutation survived. This isolates the protocol check on its own by
  // using a host that is otherwise completely legitimate and allowlisted.
  it("refuses a plain http:// request to an otherwise-legitimate, allowlisted host", () => {
    expect(() => assertEgressAllowed("http://graph.facebook.com/v23.0/me", ALLOW)).toThrow(/https/i);
  });

  // --- Beyond the plan: the base cases above are all http:// and would --
  // --- be refused by the protocol check alone, never exercising the -----
  // --- IP-blocking logic. These re-run the same and further address ------
  // --- families on https:// so the private-address check itself is -------
  // --- actually proven, not just protocol filtering. ---------------------

  describe("IPv4 encoding tricks (decimal / octal / hex / mixed) all resolve to a blocked address", () => {
    it.each([
      ["decimal", "https://2130706433/"], // 127.0.0.1
      ["octal", "https://0177.0.0.1/"], // 127.0.0.1
      ["hex+decimal mixed", "https://0x7f.1/"], // 127.0.0.1
      ["hex", "https://0x7f000001/"], // 127.0.0.1
      ["octal, all four octets", "https://017700000001/"], // 127.0.0.1
      ["class-A shorthand", "https://127.1/"], // 127.0.0.1
      ["plain dotted decimal", "https://127.0.0.1/"],
    ])("refuses loopback spelled as %s (%s)", (_label, url) => {
      expect(() => assertEgressAllowed(url, ALLOW)).toThrow(/blocked|internal/i);
    });
  });

  describe("private, link-local and cloud-metadata IPv4 ranges", () => {
    it.each([
      ["AWS/GCP/Azure metadata", "https://169.254.169.254/latest/meta-data/"],
      ["link-local, general", "https://169.254.1.1/"],
      ["RFC1918 10/8", "https://10.0.0.5/"],
      ["RFC1918 172.16/12 low end", "https://172.16.0.1/"],
      ["RFC1918 172.16/12 high end", "https://172.31.255.255/"],
      ["RFC1918 192.168/16", "https://192.168.1.1/"],
      ["loopback", "https://127.0.0.1/"],
      ["CGNAT 100.64/10", "https://100.64.0.1/"],
      ["TEST-NET-1", "https://192.0.2.1/"],
      ["multicast", "https://224.0.0.1/"],
      ["broadcast", "https://255.255.255.255/"],
      ["unspecified", "https://0.0.0.0/"],
    ])("refuses %s (%s)", (_label, url) => {
      expect(() => assertEgressAllowed(url, ALLOW)).toThrow(/blocked|internal/i);
    });

    it("does NOT block a public address that merely starts with a blocked octet lookalike (172.32, outside 172.16/12)", () => {
      // 172.32.0.1 is public -- a naive `172\.` prefix regex (like the
      // plan's own example implementation) would wrongly block this.
      expect(() => assertEgressAllowed("https://172.32.0.1/", ["172.32.0.1"])).not.toThrow();
    });
  });

  describe("IPv6 loopback, unique-local, link-local and multicast", () => {
    it.each([
      ["loopback", "::1"],
      ["unspecified", "::"],
      ["cloud metadata (AWS IPv6)", "fd00:ec2::254"],
      ["unique-local, general", "fd00::1"],
      ["link-local", "fe80::1"],
      ["multicast", "ff02::1"],
    ])("refuses %s ([%s])", (_label, addr) => {
      expect(() => assertEgressAllowed(`https://[${addr}]/`, ALLOW)).toThrow(/blocked|internal/i);
    });
  });

  // Fix round 2: these four ranges were added in fix round 1 to close a
  // review Minor, but shipped with zero tests of their own -- the exact
  // way the original assertResolvedAddressAllowed bug arrived (a real
  // fix, silently reopened by a later refactor because nothing pinned
  // it). Each of these is proven, by mutation, to fail if its range is
  // deleted -- see the "Fix round 2" section of the report for the
  // failing-output transcript.
  describe("IPv6 ranges added in fix round 1, now pinned individually", () => {
    it("refuses deprecated site-local fec0::/10", () => {
      expect(() => assertEgressAllowed("https://[fec0::1]/", ALLOW)).toThrow(/blocked|internal/i);
    });

    it("refuses the IPv6 documentation range 2001:db8::/32", () => {
      expect(() => assertEgressAllowed("https://[2001:db8::1]/", ALLOW)).toThrow(/blocked|internal/i);
    });

    it("refuses the discard-only range 100::/64", () => {
      expect(() => assertEgressAllowed("https://[100::1]/", ALLOW)).toThrow(/blocked|internal/i);
    });

    it("refuses the NAT64 local-use range 64:ff9b:1::/48", () => {
      expect(() => assertEgressAllowed("https://[64:ff9b:1::1]/", ALLOW)).toThrow(/blocked|internal/i);
    });

    it("does not over-block: fbff::1 sits just below fc00::/7 and must stay allowed", () => {
      // Pins the boundary for the fc00::/7 unique-local range. A /6
      // mutant (fix round 1's one surviving mutation) does NOT catch
      // this address either -- fbff's top 6 bits (111110) differ from
      // fc00's (111111) -- so this test does not kill that specific
      // mutant, and is not meant to. It exists to prove the range as
      // shipped is not over-broad at this boundary, in either direction.
      expect(() => assertEgressAllowed("https://[fbff::1]/", ["[fbff::1]"])).not.toThrow();
    });
  });

  describe("IPv4 address embedded inside an IPv6 literal", () => {
    it.each([
      ["IPv4-mapped, dotted form", "::ffff:127.0.0.1"],
      ["IPv4-mapped, canonical hex form", "::ffff:7f00:1"],
      ["IPv4-mapped metadata address", "::ffff:169.254.169.254"],
      ["NAT64 well-known prefix embedding loopback", "64:ff9b::7f00:1"],
      ["6to4 prefix embedding loopback", "2002:7f00:1::"],
      ["deprecated IPv4-compatible form embedding loopback", "::127.0.0.1"],
      ["deprecated IPv4-compatible form embedding metadata", "::169.254.169.254"],
    ])("refuses %s ([%s]) by extracting and checking the embedded IPv4", (_label, addr) => {
      expect(() => assertEgressAllowed(`https://[${addr}]/`, ALLOW)).toThrow(/blocked|internal/i);
    });
  });

  describe("credentials / userinfo smuggling", () => {
    it("refuses a private IP smuggled after an allowlist-shaped userinfo", () => {
      // A naive check that string-matches "graph.facebook.com" anywhere in
      // the URL would be fooled by this -- the real connection host is
      // 169.254.169.254, not graph.facebook.com.
      expect(() => assertEgressAllowed("http://graph.facebook.com@169.254.169.254/", ALLOW)).toThrow();
      expect(() => assertEgressAllowed("https://graph.facebook.com@169.254.169.254/", ALLOW)).toThrow();
    });

    it("refuses userinfo even in front of the real allowlisted host", () => {
      // There is no legitimate reason for an adapter call to carry
      // credentials in the URL; refuse outright rather than trust that
      // every downstream HTTP client parses userinfo the same way we do.
      expect(() => assertEgressAllowed("https://allowed@graph.facebook.com/", ALLOW)).toThrow(/userinfo|credential/i);
    });

    it("is not fooled by a bare '@' host trick into hitting a metadata IP", () => {
      expect(() => assertEgressAllowed("http://allowed@169.254.169.254/", ALLOW)).toThrow();
    });

    // Fix round 1, mutation-testing finding: every existing userinfo case
    // above sets a non-empty username, so a mutant that dropped the
    // `|| url.password !== ""` half of the check still passed all of
    // them -- the mutation survived. WHATWG URL parses
    // "https://:secretpw@host/" as username="" (empty), password
    // ="secretpw" (verified empirically), so a password-only userinfo is
    // exactly the input the dropped half of the check exists for.
    it("refuses password-only userinfo (empty username) on an otherwise-legitimate host", () => {
      expect(() => assertEgressAllowed("https://:secretpw@graph.facebook.com/", ALLOW)).toThrow(
        /userinfo|credential/i,
      );
    });
  });

  describe("parser-divergence tricks", () => {
    it("a backslash before '@' does not smuggle an extra host (WHATWG treats it as a path separator)", () => {
      // https://graph.facebook.com\@evil.test/ parses to hostname
      // graph.facebook.com with path "/@evil.test/" -- legitimate host,
      // must be ALLOWED, proving we read .hostname (not the raw string).
      expect(() => assertEgressAllowed("https://graph.facebook.com\\@evil.test/", ALLOW)).not.toThrow();
    });

    it("refuses a percent-encoded dot that decodes into a lookalike subdomain", () => {
      expect(() => assertEgressAllowed("https://graph.facebook.com%2eevil.test/", ALLOW)).toThrow(/allowlist/i);
    });

    it("is case-insensitive for the allowlisted host", () => {
      expect(() => assertEgressAllowed("https://GRAPH.FACEBOOK.COM/v23.0/me", ALLOW)).not.toThrow();
    });

    it("refuses malformed/unparseable input instead of silently allowing it", () => {
      expect(() => assertEgressAllowed("ht!tp://not a url", ALLOW)).toThrow();
    });
  });

  describe("localhost by name, not just by IP", () => {
    it.each(["https://localhost/admin", "https://localhost:5432/", "https://sub.localhost/"])(
      "refuses %s",
      (url) => {
        expect(() => assertEgressAllowed(url, ["localhost", "sub.localhost"])).toThrow();
      },
    );
  });

  // --- Sanity: the guard must not simply refuse everything ---------------
  it("still allows a legitimate outbound call to an allowlisted https host", () => {
    expect(() => assertEgressAllowed("https://graph.facebook.com/v23.0/me?fields=id", ALLOW)).not.toThrow();
  });

  it("allows a second, distinct allowlisted host", () => {
    expect(() => assertEgressAllowed("https://www.googleapis.com/", ["www.googleapis.com"])).not.toThrow();
  });
});
