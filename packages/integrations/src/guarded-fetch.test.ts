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
function makeFakeFetch(script: Record<string, { status: number; location?: string; body?: string }>) {
  const calls: string[] = [];
  const fake = async (input: string | URL, _init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const entry = script[url];
    if (!entry) {
      throw new Error(`fake fetch: no script entry for ${url}`);
    }
    const headers = new Headers();
    if (entry.location !== undefined) headers.set("location", entry.location);
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
});
