import { describe, expect, it } from "vitest";
import { newId } from "@smos/domain";
import { createGateway } from "./gateway.ts";
import type { GenerateRequest, GenerateResult, ModelProvider } from "./types.ts";

const costing = (costUsd: number): ModelProvider => ({
  name: "costing",
  generate: async () => ({ text: "{}", tokensIn: 1, tokensOut: 1, costUsd, modelVersion: "m1" }),
});

const ctx = { workspaceId: newId(), agentRunId: newId() };
const req: GenerateRequest = { system: "s", input: "i", schemaName: "x", maxOutputTokens: 10 };

describe("gateway budget", () => {
  it("accumulates spend across calls", async () => {
    const g = createGateway({ provider: costing(0.01), budgetUsd: 1, maxWallclockMs: 5000 });
    await g.generate(req, ctx);
    await g.generate(req, ctx);
    expect(g.spentUsd()).toBeCloseTo(0.02);
  });

  it("refuses the call that would exceed the budget, before calling the provider", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "count",
      generate: async () => {
        calls++;
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.6, modelVersion: "m1" };
      },
    };
    const g = createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000 });
    await g.generate(req, ctx);
    await expect(g.generate(req, ctx)).rejects.toThrow(/budget/i);
    expect(calls).toBe(1);
  });

  it("stops hard rather than degrading silently when a single call's cost alone exceeds the whole budget", async () => {
    const g = createGateway({ provider: costing(2), budgetUsd: 1, maxWallclockMs: 5000 });
    await expect(g.generate(req, ctx)).rejects.toThrow(/budget/i);
    expect(g.spentUsd()).toBe(0);
  });

  it("having seen an over-budget cost once, refuses every subsequent call before invoking the provider again", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "expensive",
      generate: async () => {
        calls++;
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 2, modelVersion: "m1" };
      },
    };
    const g = createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000 });
    await expect(g.generate(req, ctx)).rejects.toThrow(/budget/i);
    expect(calls).toBe(1);
    await expect(g.generate(req, ctx)).rejects.toThrow(/budget/i);
    // The second refusal must not have called the provider again: the gateway
    // remembers the worst cost it has ever observed from this provider and
    // uses it as a conservative pre-call reservation.
    expect(calls).toBe(1);
    expect(g.spentUsd()).toBe(0);
  });

  it("times out a slow provider", async () => {
    const slow: ModelProvider = {
      name: "slow",
      generate: () =>
        new Promise((r) => setTimeout(() => r({ text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0, modelVersion: "m" }), 200)),
    };
    const g = createGateway({ provider: slow, budgetUsd: 1, maxWallclockMs: 20 });
    await expect(g.generate(req, ctx)).rejects.toThrow(/timed out/i);
  });

  it("does not count a late-arriving result against the budget after the timeout already rejected", async () => {
    let resolved: GenerateResult | undefined;
    const slow: ModelProvider = {
      name: "slow-then-expensive",
      generate: () =>
        new Promise((r) => {
          setTimeout(() => {
            const result: GenerateResult = { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.9, modelVersion: "m" };
            resolved = result;
            r(result);
          }, 60);
        }),
    };
    const g = createGateway({ provider: slow, budgetUsd: 1, maxWallclockMs: 20 });
    await expect(g.generate(req, ctx)).rejects.toThrow(/timed out/i);
    // Give the abandoned provider promise time to actually resolve.
    await new Promise((r) => setTimeout(r, 100));
    expect(resolved).toBeDefined();
    expect(g.spentUsd()).toBe(0);
  });

  it("propagates a provider's own rejection without corrupting spend accounting", async () => {
    const provider: ModelProvider = {
      name: "throwing",
      generate: async () => {
        throw new Error("provider blew up");
      },
    };
    const g = createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000 });
    await expect(g.generate(req, ctx)).rejects.toThrow(/provider blew up/);
    expect(g.spentUsd()).toBe(0);

    // The gateway must still work normally afterward.
    const g2 = createGateway({ provider: costing(0.1), budgetUsd: 1, maxWallclockMs: 5000 });
    await g2.generate(req, ctx);
    expect(g2.spentUsd()).toBeCloseTo(0.1);
  });

  it("rejects a negative cost from the provider instead of letting it reduce the running total", async () => {
    const g = createGateway({ provider: costing(-5), budgetUsd: 1, maxWallclockMs: 5000 });
    await expect(g.generate(req, ctx)).rejects.toThrow(/cost/i);
    expect(g.spentUsd()).toBe(0);
  });

  it("rejects a NaN cost from the provider instead of corrupting the running total", async () => {
    const g = createGateway({ provider: costing(Number.NaN), budgetUsd: 1, maxWallclockMs: 5000 });
    await expect(g.generate(req, ctx)).rejects.toThrow(/cost/i);
    expect(g.spentUsd()).toBe(0);
  });

  it("logs tokensIn/tokensOut under their real names and they survive @smos/telemetry's redact()", async () => {
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const g = createGateway({ provider: costing(0.01), budgetUsd: 1, maxWallclockMs: 5000 });
      await g.generate(req, ctx);
    } finally {
      process.stdout.write = write;
    }
    const line = lines.find((l) => l.includes('"msg":"model call"'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line as string) as Record<string, unknown>;
    // redact() now recognizes tokensIn/tokensOut as count-shaped, not
    // secret-shaped, so the gateway can log them under their real,
    // GenerateResult-matching names.
    expect(parsed["tokensIn"]).toBe(1);
    expect(parsed["tokensOut"]).toBe(1);
    expect(line).not.toContain("[redacted]");
  });

  it("invokes the provider exactly once when two calls race concurrently against a budget that fits only one more call", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "concurrent",
      generate: async () => {
        calls++;
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.7, modelVersion: "m1" };
      },
    };
    const g = createGateway({ provider, budgetUsd: 1.4, maxWallclockMs: 5000 });
    // Warm-up call establishes maxCostSeen = 0.7 and leaves exactly 0.7
    // remaining -- budget "fits exactly one more call at 0.7".
    await g.generate(req, ctx);
    expect(calls).toBe(1);

    const settled = await Promise.allSettled([g.generate(req, ctx), g.generate(req, ctx)]);
    // Without an in-flight reservation, both concurrent calls read the same
    // stale spent/maxCostSeen before either lands, and both pass the
    // pre-call check -- the provider gets invoked twice even though only
    // one more call fits in budget.
    expect(calls).toBe(2); // 1 warm-up + exactly 1 of the 2 concurrent calls
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejection = settled.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejection.reason as Error).message).toMatch(/budget/i);
    expect(g.spentUsd()).toBeCloseTo(1.4);
  });

  it("does not strand a reservation after a successful call, so a second call that exactly fits still succeeds", async () => {
    const g = createGateway({ provider: costing(0.7), budgetUsd: 1.4, maxWallclockMs: 5000 });
    await g.generate(req, ctx);
    // If the first call's reservation were never released, this call would
    // be wrongly refused even though the real remaining budget (0.7) is
    // exactly enough for it.
    await g.generate(req, ctx);
    expect(g.spentUsd()).toBeCloseTo(1.4);
  });

  it("releases its reservation after the provider throws, so it does not permanently shrink the usable budget", async () => {
    let n = 0;
    const provider: ModelProvider = {
      name: "throw-once",
      generate: async () => {
        n++;
        if (n === 2) throw new Error("boom");
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.7, modelVersion: "m1" };
      },
    };
    const g = createGateway({ provider, budgetUsd: 1.4, maxWallclockMs: 5000 });
    await g.generate(req, ctx); // n=1: spent=0.7, maxCostSeen=0.7, remaining=0.7
    await expect(g.generate(req, ctx)).rejects.toThrow(/boom/); // n=2: throws after reserving 0.7
    // Only succeeds if the failed call's reservation was released -- real
    // remaining is still exactly 0.7 since the throw never spent anything.
    await g.generate(req, ctx); // n=3
    expect(g.spentUsd()).toBeCloseTo(1.4);
  });

  it("releases its reservation after a timeout, so it does not permanently shrink the usable budget", async () => {
    let n = 0;
    const provider: ModelProvider = {
      name: "slow-once",
      generate: async () => {
        n++;
        if (n === 2) {
          await new Promise((r) => setTimeout(r, 200));
        }
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.7, modelVersion: "m1" };
      },
    };
    const g = createGateway({ provider, budgetUsd: 1.4, maxWallclockMs: 20 });
    await g.generate(req, ctx); // n=1: fast, spent=0.7, maxCostSeen=0.7, remaining=0.7
    await expect(g.generate(req, ctx)).rejects.toThrow(/timed out/i); // n=2: times out after reserving 0.7
    // Only succeeds if the timed-out call's reservation was released.
    await g.generate(req, ctx); // n=3: fast again
    expect(g.spentUsd()).toBeCloseTo(1.4);
    // Let the abandoned n=2 call actually settle so it doesn't leak a
    // pending timer into later tests.
    await new Promise((r) => setTimeout(r, 250));
  });

  it("a hostile negative-cost result cannot be used to fund a later over-budget call", async () => {
    let call = 0;
    const provider: ModelProvider = {
      name: "hostile",
      generate: async () => {
        call++;
        if (call === 1) return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: -1000, modelVersion: "m1" };
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.5, modelVersion: "m1" };
      },
    };
    const g = createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000 });
    await expect(g.generate(req, ctx)).rejects.toThrow(/cost/i);
    expect(g.spentUsd()).toBe(0);
    await g.generate(req, ctx);
    expect(g.spentUsd()).toBeCloseTo(0.5);
  });
});
