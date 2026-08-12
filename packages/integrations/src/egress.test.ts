import { describe, expect, it } from "vitest";
import { assertEgressAllowed } from "./egress.ts";

const ALLOW = ["graph.facebook.com"];

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

  describe("IPv4 address embedded inside an IPv6 literal", () => {
    it.each([
      ["IPv4-mapped, dotted form", "::ffff:127.0.0.1"],
      ["IPv4-mapped, canonical hex form", "::ffff:7f00:1"],
      ["IPv4-mapped metadata address", "::ffff:169.254.169.254"],
      ["NAT64 well-known prefix embedding loopback", "64:ff9b::7f00:1"],
      ["6to4 prefix embedding loopback", "2002:7f00:1::"],
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
