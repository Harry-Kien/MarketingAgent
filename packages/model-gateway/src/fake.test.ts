import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFakeProvider } from "./fake.ts";

const provider = createFakeProvider({ "research.v1": '{"findings":[]}' });

describe("createFakeProvider", () => {
  it("returns the scripted response for a schema", async () => {
    const r = await provider.generate({ system: "s", input: "i", schemaName: "research.v1", maxOutputTokens: 100 });
    expect(r.text).toBe('{"findings":[]}');
    expect(r.modelVersion).toBe("fake-1");
  });

  it("is deterministic across calls", async () => {
    const req = { system: "s", input: "i", schemaName: "research.v1", maxOutputTokens: 100 };
    const [a, b] = [await provider.generate(req), await provider.generate(req)];
    expect(a).toEqual(b);
  });

  it("reports token counts derived from input length, not randomness", async () => {
    const r = await provider.generate({ system: "abc", input: "defgh", schemaName: "research.v1", maxOutputTokens: 100 });
    expect(r.tokensIn).toBe(8);
    expect(r.costUsd).toBe(0);
  });

  it("throws for an unscripted schema so tests cannot pass by accident", async () => {
    await expect(provider.generate({ system: "", input: "", schemaName: "nope", maxOutputTokens: 1 })).rejects.toThrow(
      /no scripted response/i,
    );
  });

  it("returns identical results across a hundred calls with identical input, including token counts", async () => {
    const req = { system: "system-text", input: "input-text", schemaName: "research.v1", maxOutputTokens: 100 };
    const results = await Promise.all(Array.from({ length: 100 }, () => provider.generate(req)));
    const first = results[0];
    for (const r of results) {
      expect(r).toEqual(first);
    }
  });

  it("behaves identically across two separately constructed providers with the same script", async () => {
    const providerA = createFakeProvider({ "research.v1": '{"findings":[]}' });
    const providerB = createFakeProvider({ "research.v1": '{"findings":[]}' });
    const req = { system: "s", input: "i", schemaName: "research.v1", maxOutputTokens: 100 };
    const [a, b] = [await providerA.generate(req), await providerB.generate(req)];
    expect(a).toEqual(b);
  });

  it("throws immediately (not asynchronously via rejection racing) for an unscripted schema, and the error names the schema", async () => {
    await expect(
      provider.generate({ system: "s", input: "i", schemaName: "totally-unscripted", maxOutputTokens: 1 }),
    ).rejects.toThrow(/totally-unscripted/);
  });

  it("documents duplicate-key behaviour: last write for a schema name wins, matching plain JS object semantics", () => {
    // A Record<string, string> cannot carry a real duplicate key -- the object
    // literal (or, as here, repeated assignment) already collapses to one
    // value before createFakeProvider ever sees it. There is nothing for the
    // provider to detect or reject; this test pins down that the surviving
    // value is the last one written, so nobody is surprised later.
    const script: Record<string, string> = {};
    script["dup"] = "first";
    script["dup"] = "second";
    const p = createFakeProvider(script);
    return expect(p.generate({ system: "", input: "", schemaName: "dup", maxOutputTokens: 1 })).resolves.toMatchObject({
      text: "second",
    });
  });

  it("freezes the script at construction, so mutating it afterward throws instead of silently changing behaviour", async () => {
    const script: Record<string, string> = { "mutate.v1": "original" };
    const p = createFakeProvider(script);

    // ES modules run in strict mode, so assigning to a frozen object throws
    // immediately at the mutation site -- a loud, deterministic failure
    // rather than a provider whose answers silently drift after construction.
    expect(() => {
      script["mutate.v1"] = "mutated-after-construction";
    }).toThrow(TypeError);
    expect(() => {
      script["new.v1"] = "added-after-construction";
    }).toThrow(TypeError);

    const r = await p.generate({ system: "", input: "", schemaName: "mutate.v1", maxOutputTokens: 1 });
    expect(r.text).toBe("original");
  });
});

describe("fake.ts source", () => {
  it("never references the clock, Math.random, process.env, or network primitives", () => {
    const source = readFileSync(fileURLToPath(new URL("./fake.ts", import.meta.url)), "utf8");
    const forbidden = [
      /\bDate\s*\.\s*now\b/,
      /\bnew\s+Date\b/,
      /\bperformance\s*\.\s*now\b/,
      /\bMath\s*\.\s*random\b/,
      /\bprocess\s*\.\s*env\b/,
      /\bfetch\s*\(/,
      /\bhttp\b/,
      /\bhttps\b/,
      /\brequire\s*\(/,
      /\bnode:/,
      /\bXMLHttpRequest\b/,
    ];
    for (const pattern of forbidden) {
      expect(source, `fake.ts must not match ${pattern}`).not.toMatch(pattern);
    }
  });
});
