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
    const g = createGateway({ provider: costing(0.01), budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.05 });
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
    // Fix round 2: estimatedCostUsd is now contractually the MAXIMUM this
    // call may cost -- must be >= the real 0.6 the provider returns, or
    // the first (successful, within-budget) call would itself be refused
    // as a contract violation.
    const g = createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.6 });
    await g.generate(req, ctx);
    await expect(g.generate(req, ctx)).rejects.toThrow(/budget/i);
    expect(calls).toBe(1);
  });

  it("stops hard rather than degrading silently when a single call's cost alone exceeds the whole budget", async () => {
    const g = createGateway({ provider: costing(2), budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.05 });
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
    const g = createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.05 });
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
    const g = createGateway({ provider: slow, budgetUsd: 1, maxWallclockMs: 20, estimatedCostUsd: 0.05 });
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
    const g = createGateway({ provider: slow, budgetUsd: 1, maxWallclockMs: 20, estimatedCostUsd: 0.05 });
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
    const g = createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.05 });
    await expect(g.generate(req, ctx)).rejects.toThrow(/provider blew up/);
    expect(g.spentUsd()).toBe(0);

    // The gateway must still work normally afterward.
    const g2 = createGateway({ provider: costing(0.1), budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.1 });
    await g2.generate(req, ctx);
    expect(g2.spentUsd()).toBeCloseTo(0.1);
  });

  it("rejects a negative cost from the provider instead of letting it reduce the running total", async () => {
    const g = createGateway({ provider: costing(-5), budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.05 });
    await expect(g.generate(req, ctx)).rejects.toThrow(/cost/i);
    expect(g.spentUsd()).toBe(0);
  });

  it("rejects a NaN cost from the provider instead of corrupting the running total", async () => {
    const g = createGateway({ provider: costing(Number.NaN), budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.05 });
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
      const g = createGateway({ provider: costing(0.01), budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.05 });
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
    // estimatedCostUsd = 0.7 exactly matches the real per-call cost -- the
    // declared maximum is honest here, so the warm-up call (which needs to
    // actually succeed to establish maxCostSeen) is not itself refused as
    // a contract violation.
    const g = createGateway({ provider, budgetUsd: 1.4, maxWallclockMs: 5000, estimatedCostUsd: 0.7 });
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
    const g = createGateway({ provider: costing(0.7), budgetUsd: 1.4, maxWallclockMs: 5000, estimatedCostUsd: 0.7 });
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
    const g = createGateway({ provider, budgetUsd: 1.4, maxWallclockMs: 5000, estimatedCostUsd: 0.7 });
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
    const g = createGateway({ provider, budgetUsd: 1.4, maxWallclockMs: 20, estimatedCostUsd: 0.7 });
    await g.generate(req, ctx); // n=1: fast, spent=0.7, maxCostSeen=0.7, remaining=0.7
    await expect(g.generate(req, ctx)).rejects.toThrow(/timed out/i); // n=2: times out after reserving 0.7
    // Only succeeds if the timed-out call's reservation was released.
    await g.generate(req, ctx); // n=3: fast again
    expect(g.spentUsd()).toBeCloseTo(1.4);
    // Let the abandoned n=2 call actually settle so it doesn't leak a
    // pending timer into later tests.
    await new Promise((r) => setTimeout(r, 250));
  });

  // Fix round 1, CRITICAL. `reserved += reservation` where
  // `reservation = maxCostSeen` (pre-fix) is 0 until the FIRST call ever
  // returns -- a reservation of $0 reserves nothing. A cold burst of
  // concurrent calls therefore all pass the pre-call check and all reach
  // the real provider, even though only a handful fit the budget. The
  // "exactly once" concurrency test above never catches this: it always
  // runs a sequential warm-up call first, which is precisely what makes
  // maxCostSeen non-zero before the race starts. These two tests fire
  // straight into a gateway that has NEVER made a call.
  // Fix round 2 update: the cold-start GATE (see gateway.ts's header,
  // defence 2) now bounds a truly cold burst to exactly ONE call reaching
  // the provider, regardless of budget/estimate arithmetic -- tighter than
  // round 1's "however many fit the estimate" bound. Assertions below were
  // "calls * 0.15 <= budget" in round 1; now exact, since the gate makes
  // the outcome deterministic (verified: JS evaluates each synchronous
  // `generate()` call-prefix, including acquiring the gate, to completion
  // before the next one in the array begins -- there is no interleaving
  // before the first `await`).
  it("cold gateway, N=50 concurrent: provider invocation count never exceeds what the budget can pay for (round 1 CRITICAL)", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "cold-burst-50",
      generate: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.15, modelVersion: "m1" };
      },
    };
    // estimatedCostUsd matches the real per-call cost (0.15) -- an honest
    // declared maximum, so no contract violation fires either.
    const g = createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.15 });
    await Promise.allSettled(Array.from({ length: 50 }, () => g.generate(req, ctx)));
    expect(calls).toBe(1);
  });

  it("cold gateway, N=10 concurrent: same property at smaller N", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "cold-burst-10",
      generate: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.15, modelVersion: "m1" };
      },
    };
    const g = createGateway({ provider, budgetUsd: 0.5, maxWallclockMs: 5000, estimatedCostUsd: 0.15 });
    await Promise.allSettled(Array.from({ length: 10 }, () => g.generate(req, ctx)));
    expect(calls).toBe(1);
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
    const g = createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.5 });
    await expect(g.generate(req, ctx)).rejects.toThrow(/cost/i);
    expect(g.spentUsd()).toBe(0);
    await g.generate(req, ctx);
    expect(g.spentUsd()).toBeCloseTo(0.5);
  });
});

// Fix round 2, CRITICAL. Round 1's estimatedCostUsd closed the $0-reservation
// leak but was never validated -- every bad value except +Infinity failed
// OPEN. Measured against the pre-fix code (see task-7-report.md, "Fix round
// 2"): estimate 0 / negative / NaN / omitted all let a full N=50 cold burst
// through ($35 of real spend against a $1 budget at $0.70/call); NaN was
// PERMANENT (200/200 sequential calls still got through, because
// `NaN > remaining` is always false); an honest-looking low estimate (0.01
// vs a real 0.70) also let all 50 through, since every concurrent call in
// the burst reserves the same too-low number before any of them can prove
// it wrong.
describe("gateway budget: estimatedCostUsd validation and contract (fix round 2, CRITICAL)", () => {
  it.each([
    ["zero", 0],
    ["negative", -5],
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["missing (undefined)", undefined],
  ])("constructing a gateway with estimatedCostUsd = %s throws immediately", (_label, badValue) => {
    expect(() =>
      createGateway({
        provider: costing(0.1),
        budgetUsd: 1,
        maxWallclockMs: 5000,
        // Cast away the type to reproduce the reviewer's exact attack: an
        // un-typechecked JS caller, not merely a TypeScript compile error.
        estimatedCostUsd: badValue as never,
      }),
    ).toThrow(/estimatedCostUsd/i);
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
  ])(
    "cold gateway, N=50, hostile estimate %s: construction itself refuses, so the provider is invoked zero times",
    (_label, badValue) => {
      let calls = 0;
      const provider: ModelProvider = {
        name: "hostile-estimate",
        generate: async () => {
          calls++;
          return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.7, modelVersion: "m1" };
        },
      };
      expect(() =>
        createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: badValue as never }),
      ).toThrow();
      // Never even reached the point of firing 50 calls -- construction
      // failed first, so there is no gateway instance to call generate() on.
      expect(calls).toBe(0);
    },
  );

  it("cold gateway, N=50, an honest-looking but WRONG low estimate (0.01 declared vs 0.70 real): the cold-start gate caps exposure to exactly one call, not fifty", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "underestimated",
      generate: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.7, modelVersion: "m1" };
      },
    };
    const g = createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.01 });
    const settled = await Promise.allSettled(Array.from({ length: 50 }, () => g.generate(req, ctx)));
    // Round 1 alone measured 50/50 here. The cold-start gate closes the
    // rest: only the ONE call that acquires the gate can ever reach the
    // provider while the gateway is cold, regardless of how wrong the
    // declared estimate turns out to be.
    expect(calls).toBe(1);
    // That one call still surfaces the contract violation loudly rather
    // than silently succeeding (see the dedicated test below) -- so it is
    // among the 50 rejections, not the sole fulfillment.
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(0);
  });

  it("after a bad-ESTIMATE gateway fails to even construct, a correctly-constructed gateway is completely unaffected (no shared, corruptible module state)", () => {
    expect(() => createGateway({ provider: costing(0.1), budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: Number.NaN })).toThrow();
    // A fresh, validly-constructed gateway works normally -- construction
    // validation is per-instance, not a poisoned global.
    const g = createGateway({ provider: costing(0.1), budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.1 });
    expect(g.spentUsd()).toBe(0);
  });

  // The permanence case: reproduced live pre-fix as 200/200 sequential calls
  // still reaching the provider after ONE NaN-flavoured attempt, because
  // `NaN > remaining` can never become true. A NaN *estimate* can no longer
  // exist (construction throws), so this proves the remaining, still-live
  // route to a bad number: a NaN/negative *actual* cost from the provider
  // itself. The invalid-cost check must not corrupt maxCostSeen, and the
  // very next call must still be judged correctly.
  it("after a provider returns an invalid (NaN) actual cost, the budget check still works correctly for the next 10 sequential calls", async () => {
    let call = 0;
    const provider: ModelProvider = {
      name: "nan-then-honest",
      generate: async () => {
        call++;
        if (call === 1) return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: Number.NaN, modelVersion: "m1" };
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.1, modelVersion: "m1" };
      },
    };
    const g = createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.1 });
    await expect(g.generate(req, ctx)).rejects.toThrow(/cost/i); // call 1: NaN, refused
    expect(g.spentUsd()).toBe(0);

    // 10 more real, honest calls at $0.10 each -- budget check must still
    // correctly track spend and correctly refuse once exhausted, proving
    // the NaN attempt left no permanent damage (round 1's bug: this stayed
    // broken forever after a single NaN-flavoured value).
    for (let i = 0; i < 10; i++) {
      await g.generate(req, ctx);
    }
    expect(g.spentUsd()).toBeCloseTo(1.0);
    await expect(g.generate(req, ctx)).rejects.toThrow(/budget/i);
  });

  it("an actual cost exceeding the declared estimatedCostUsd is surfaced as a thrown contract violation, not silently absorbed", async () => {
    const g = createGateway({ provider: costing(0.7), budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.01 });
    await expect(g.generate(req, ctx)).rejects.toThrow(/contract violation|exceeding/i);
    // The real spend is still recorded -- surfacing the violation is not
    // the same as pretending the money was never spent.
    expect(g.spentUsd()).toBeCloseTo(0.7);
  });

  it("subsequent reservations self-correct after a contract violation: a second call no longer under-reserves", async () => {
    let call = 0;
    const provider: ModelProvider = {
      name: "escalating",
      generate: async () => {
        call++;
        // Both calls cost 0.7 -- the SECOND call proves maxCostSeen was
        // corrected by the first, even though the first call itself threw.
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.7, modelVersion: "m1" };
      },
    };
    const g = createGateway({ provider, budgetUsd: 0.75, maxWallclockMs: 5000, estimatedCostUsd: 0.01 });
    await expect(g.generate(req, ctx)).rejects.toThrow(/contract violation|exceeding/i); // call 1: violates estimate, but spends 0.7
    expect(g.spentUsd()).toBeCloseTo(0.7);
    // Only 0.05 remains. If the second call's reservation still used the
    // stale 0.01 estimate, it would wrongly proceed and try to spend past
    // the budget; maxCostSeen (now 0.7) correctly refuses it pre-call
    // instead.
    await expect(g.generate(req, ctx)).rejects.toThrow(/budget/i);
    expect(call).toBe(1); // the second call never reached the provider at all
  });
});
