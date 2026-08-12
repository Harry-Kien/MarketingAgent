import { describe, expect, it } from "vitest";
import { guardedFetch } from "./guarded-fetch.ts";

const ALLOW = ["graph.facebook.com", "cdn.example.com"];

/**
 * A hand-rolled fake `fetch` -- never opens a socket. Each call is looked
 * up by exact URL against a fixed script of responses, so a redirect chain
 * is fully deterministic and inspectable, including counting how many
 * times each URL was actually requested (used to prove a bounded redirect
 * loop stops calling the network instead of hanging).
 */
function makeFakeFetch(
  script: Record<string, { status: number; location?: string | string[]; body?: string }>,
) {
  const calls: string[] = [];
  const fake = async (input: string | URL, _init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const entry = script[url];
    if (!entry) {
      throw new Error(`fake fetch: no script entry for ${url}`);
    }
    const headers = new Headers();
    if (entry.location !== undefined) {
      // A script entry may name Location more than once, exactly like a
      // real (malformed but real-world-seen) server response with
      // duplicate headers -- Headers.append (not .set) preserves both,
      // and Headers.get then joins them with ", " per the Fetch spec.
      for (const loc of Array.isArray(entry.location) ? entry.location : [entry.location]) {
        headers.append("location", loc);
      }
    }
    return new Response(entry.body ?? null, { status: entry.status, headers });
  };
  return { fake, calls };
}

describe("guardedFetch", () => {
  it("refuses a 30x whose Location points at a forbidden host", async () => {
    const { fake } = makeFakeFetch({
      "https://graph.facebook.com/start": {
        status: 302,
        location: "https://169.254.169.254/latest/meta-data/",
      },
    });

    // Message-checked, not just "it threw": the fake has no script entry
    // for the forbidden URL either, so a mutant that skipped re-running the
    // guard on redirect hops would ALSO throw here (from the fake's own
    // "no script entry" error) and this assertion would wrongly look like
    // it passed for the right reason. Asserting the guard's own wording
    // closes that hole -- confirmed by mutation testing (fix round 1).
    await expect(guardedFetch("https://graph.facebook.com/start", ALLOW, undefined, fake)).rejects.toThrow(
      /blocked|internal/i,
    );
  });

  it("refuses a 30x whose Location points at a host that is simply not on the allowlist", async () => {
    const { fake } = makeFakeFetch({
      "https://graph.facebook.com/start": {
        status: 302,
        location: "https://evil.test/steal",
      },
    });

    await expect(guardedFetch("https://graph.facebook.com/start", ALLOW, undefined, fake)).rejects.toThrow(
      /allowlist/i,
    );
  });

  it("bounds a redirect loop instead of following it forever", async () => {
    const { fake, calls } = makeFakeFetch({
      "https://graph.facebook.com/a": { status: 302, location: "https://graph.facebook.com/b" },
      "https://graph.facebook.com/b": { status: 302, location: "https://graph.facebook.com/a" },
    });

    await expect(guardedFetch("https://graph.facebook.com/a", ALLOW, undefined, fake)).rejects.toThrow(/redirect/i);
    // Proves it actually stopped rather than hanging or exhausting memory:
    // a bounded number of real fetch calls happened, not an unbounded loop.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThan(50);
  });

  it("follows a redirect chain that stays within the allowlist and returns the final response", async () => {
    const { fake } = makeFakeFetch({
      "https://graph.facebook.com/old": { status: 301, location: "https://graph.facebook.com/new" },
      "https://graph.facebook.com/new": { status: 200, body: "ok" },
    });

    const response = await guardedFetch("https://graph.facebook.com/old", ALLOW, undefined, fake);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("still completes a legitimate, non-redirecting request against the fake -- not simply refusing everything", async () => {
    const { fake } = makeFakeFetch({
      "https://graph.facebook.com/v23.0/me": { status: 200, body: '{"id":"123"}' },
    });

    const response = await guardedFetch("https://graph.facebook.com/v23.0/me", ALLOW, undefined, fake);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "123" });
  });

  it("refuses the initial URL itself before ever calling fetch, if it fails the guard", async () => {
    const { fake, calls } = makeFakeFetch({});
    await expect(guardedFetch("https://169.254.169.254/", ALLOW, undefined, fake)).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  it("always calls the underlying fetch with redirect: manual, even if the caller's init said otherwise", async () => {
    let seenRedirectMode: string | undefined;
    const fake = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
      seenRedirectMode = init?.redirect;
      return new Response("ok", { status: 200 });
    };

    await guardedFetch("https://graph.facebook.com/v23.0/me", ALLOW, { redirect: "follow" }, fake);
    expect(seenRedirectMode).toBe("manual");
  });

  // --- Fix round 2 -------------------------------------------------------

  describe("maxRedirects must be a finite, non-negative number", () => {
    it.each([Infinity, -Infinity, NaN])(
      "rejects maxRedirects: %s before ever calling fetch, instead of unbounding the loop",
      async (bad) => {
        // hop >= Infinity and hop >= NaN are both always false, so an
        // unvalidated value here doesn't cause an SSRF (every hop is still
        // guard-checked) -- it hangs the redirect loop forever instead.
        // Caught by refusing up front, before the first fetch call, the
        // same way an invalid initial URL already is.
        const { fake, calls } = makeFakeFetch({
          "https://graph.facebook.com/v23.0/me": { status: 200, body: "ok" },
        });
        await expect(
          guardedFetch("https://graph.facebook.com/v23.0/me", ALLOW, { maxRedirects: bad }, fake),
        ).rejects.toThrow(/maxRedirects|finite/i);
        expect(calls.length).toBe(0);
      },
    );

    it("still accepts maxRedirects: 0 (a legitimate 'never follow redirects' value)", async () => {
      const { fake } = makeFakeFetch({
        "https://graph.facebook.com/v23.0/me": { status: 200, body: "ok" },
      });
      const response = await guardedFetch(
        "https://graph.facebook.com/v23.0/me",
        ALLOW,
        { maxRedirects: 0 },
        fake,
      );
      expect(response.status).toBe(200);
    });
  });

  describe("relative and protocol-relative Location", () => {
    it("resolves a path-relative Location against the current URL and re-checks the resolved form", async () => {
      const { fake } = makeFakeFetch({
        "https://graph.facebook.com/old": { status: 301, location: "/new" },
        "https://graph.facebook.com/new": { status: 200, body: "ok" },
      });
      const response = await guardedFetch("https://graph.facebook.com/old", ALLOW, undefined, fake);
      expect(response.status).toBe(200);
    });

    it("resolves a protocol-relative Location (//host/path) and allows it when the host is allowlisted", async () => {
      const { fake } = makeFakeFetch({
        "https://graph.facebook.com/old": { status: 301, location: "//cdn.example.com/asset" },
        "https://cdn.example.com/asset": { status: 200, body: "ok" },
      });
      const response = await guardedFetch("https://graph.facebook.com/old", ALLOW, undefined, fake);
      expect(response.status).toBe(200);
    });

    it("refuses a protocol-relative Location (//host/path) when the host is forbidden -- the commonest real-world redirect form", async () => {
      const { fake } = makeFakeFetch({
        "https://graph.facebook.com/old": { status: 301, location: "//169.254.169.254/latest/meta-data/" },
      });
      await expect(guardedFetch("https://graph.facebook.com/old", ALLOW, undefined, fake)).rejects.toThrow(
        /blocked|internal/i,
      );
    });
  });

  describe("duplicate Location headers -- recorded behavior, not a bypass", () => {
    // Headers.get joins repeated header values with ", " per the Fetch
    // spec. Verified this is not a bypass: the joined string is passed
    // whole to `new URL(location, currentUrl)`, so its *hostname* is
    // whichever value came first -- the comma and the rest of the second
    // value just become part of the (percent-encoded) path. The real
    // client (fetchImpl, called with this same string) and the guard
    // therefore always agree on which host is actually dialed. This test
    // exists so a future "helpful" rewrite of the redirect-resolution
    // line (e.g. "smartly" splitting on "," and taking one segment) has
    // something to break instead of silently reopening a hole.
    it("resolves to the FIRST duplicate value when it is allowed, treating the rest as an inert path suffix", async () => {
      // Headers.get("location") joins these into
      // "https://graph.facebook.com/a, https://evil.test/b", which
      // `new URL(joined, currentUrl)` resolves to exactly
      // "https://graph.facebook.com/a,%20https://evil.test/b" -- hostname
      // graph.facebook.com, "evil.test" reduced to a harmless path
      // fragment. Verified empirically before writing this test.
      const { fake } = makeFakeFetch({
        "https://graph.facebook.com/start": {
          status: 302,
          location: ["https://graph.facebook.com/a", "https://evil.test/b"],
        },
        "https://graph.facebook.com/a,%20https://evil.test/b": { status: 200, body: "ok" },
      });
      const response = await guardedFetch("https://graph.facebook.com/start", ALLOW, undefined, fake);
      expect(response.status).toBe(200);
    });

    it("refuses when the FIRST duplicate value is forbidden, even if a later value would be allowed", async () => {
      // Resolves to "https://169.254.169.254/x,%20https://graph.facebook.com/y"
      // -- hostname 169.254.169.254, blocked before fetchImpl is ever
      // called (no script entry needed for it here).
      const { fake } = makeFakeFetch({
        "https://graph.facebook.com/start": {
          status: 302,
          location: ["https://169.254.169.254/x", "https://graph.facebook.com/y"],
        },
      });
      await expect(guardedFetch("https://graph.facebook.com/start", ALLOW, undefined, fake)).rejects.toThrow(
        /blocked|internal/i,
      );
    });
  });
});
