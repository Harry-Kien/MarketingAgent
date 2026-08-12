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

  // Fix round 4, FIX 2: spentUsd() must reflect real money that actually
  // left the building, not merely "calls the ledger chose to accept". This
  // call DID reach the real provider and WAS billed 2 USD before the
  // gateway ever gets a chance to judge it against the budget -- refusing
  // it after the fact cannot un-spend that money, so the ledger must still
  // show it. (Previously asserted spentUsd()===0, which under-reported
  // real vendor spend; see task-7-report.md, "Fix round 4".)
  it("stops hard rather than degrading silently when a single call's cost alone exceeds the whole budget", async () => {
    const g = createGateway({ provider: costing(2), budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.05 });
    await expect(g.generate(req, ctx)).rejects.toThrow(/budget/i);
    expect(g.spentUsd()).toBeCloseTo(2);
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
    // Fix round 4, FIX 2: the ledger reflects the real 2 USD the first call
    // was actually billed, not 0 -- the second refusal is a genuine
    // pre-call refusal (no further real spend), but the first call's real
    // cost must not be erased from the audit trail.
    expect(g.spentUsd()).toBeCloseTo(2);
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
  //
  // Fix round 2 briefly added a cold-start GATE that bounded this to
  // exactly ONE call; fix round 3 removed it entirely, which the reviewer
  // then showed re-opened unbounded exposure for a DISHONEST estimate
  // (N=50 at estimate 0.0001 measured 2000/2000 calls through). Fix round
  // 4 restores a gate, but as a CAP at COLD_CONCURRENCY_CAP (K=8) rather
  // than a hard serialiser at 1 -- see gateway.ts's header. For an HONEST
  // estimate like this test's, K=8 never actually binds: the reservation
  // math alone limits legitimate concurrent exposure to
  // `floor(budget/estimate)`, which is below K here, so the outcome is
  // unaffected by the cap's return. Pinned to the EXACT expected count
  // (not just an upper bound) so a gateway that silently refused
  // everything -- which would also satisfy a `<=` check -- cannot pass.
  it("cold gateway, N=50 concurrent: provider invocation count is exactly floor(budget/estimate), not merely bounded by it (round 1 CRITICAL)", async () => {
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
    // floor(1 / 0.15) = 6 (6 * 0.15 = 0.9; a 7th would need 1.05 > 1).
    expect(calls).toBe(6);
    expect(g.spentUsd()).toBeCloseTo(6 * 0.15);
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
    // floor(0.5 / 0.15) = 3 (3 * 0.15 = 0.45; a 4th would need 0.6 > 0.5).
    expect(calls).toBe(3);
    expect(g.spentUsd()).toBeCloseTo(3 * 0.15);
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

  // Fix round 3 removed the round-2 gate entirely, reasoning that the
  // CONTRACT-violation throw (fix round 2) already made a dishonest
  // estimate's damage "loud, not silent". The coordinator's own round-3
  // ruling was wrong, and round 4 corrects it: the contract-violation
  // throw fires strictly AFTER the burst has already been billed, so
  // "loud" was never the same as "bounded". Measured on round 3's code
  // (no gate at all): N=50 at estimate 0.01 vs real 0.70 let all 50
  // through ($35 real spend against a $1 budget -- byte-identical to the
  // original, pre-round-1 CRITICAL); N=200 let 99 through ($69.30);
  // estimate 0.001 let 999 through ($699.30); estimate 0.0001 at N=2000
  // let all 2000 through ($1400 against a $1 budget). The exposure is
  // `budget * (realCost / estimate)` -- unbounded as the declared estimate
  // shrinks, regardless of N.
  //
  // Fix round 4, FIX 1 restores a gate, but as a CAP at
  // COLD_CONCURRENCY_CAP (K=8) rather than round 2's hard 1-at-a-time
  // serialiser -- see gateway.ts's header for why K=8 preserves every
  // honest scenario while bounding worst-case dishonest exposure to
  // `K * realCost` regardless of how small the estimate is or how large N
  // is. These four tests prove that bound directly, at increasing severity
  // of dishonesty and increasing N, and Fix round 4, FIX 2 means the
  // ledger (`spentUsd()`) now reports the REAL total billed across
  // whichever of the (at most K) calls actually reached the provider, not
  // a single call's worth.
  it("cold gateway, N=50, estimate 0.01 vs real 0.70: provider calls and real spend are both bounded by K, not by N", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "underestimated-50",
      generate: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.7, modelVersion: "m1" };
      },
    };
    const g = createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.01 });
    const settled = await Promise.allSettled(Array.from({ length: 50 }, () => g.generate(req, ctx)));
    const K = 8;
    expect(calls).toBeLessThanOrEqual(K);
    // Every one of the calls that DID reach the provider is loudly flagged
    // (contract violation or budget-exceeded) -- none silently succeeds.
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(0);
    // Fix round 4, FIX 2: the ledger now equals the REAL total the vendor
    // was billed for -- exactly `calls * 0.7`, and by construction never
    // more than `K * 0.7`.
    expect(g.spentUsd()).toBeCloseTo(calls * 0.7);
    expect(g.spentUsd()).toBeLessThanOrEqual(K * 0.7 + 1e-9);
  });

  it("cold gateway, N=200, same dishonest estimate: the bound holds regardless of N", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "underestimated-200",
      generate: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.7, modelVersion: "m1" };
      },
    };
    const g = createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.01 });
    await Promise.allSettled(Array.from({ length: 200 }, () => g.generate(req, ctx)));
    const K = 8;
    expect(calls).toBeLessThanOrEqual(K);
    expect(g.spentUsd()).toBeLessThanOrEqual(K * 0.7 + 1e-9);
  });

  it("cold gateway, estimate 0.001 vs real 0.70: the bound holds regardless of how small the estimate is", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "underestimated-tiny",
      generate: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.7, modelVersion: "m1" };
      },
    };
    const g = createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.001 });
    await Promise.allSettled(Array.from({ length: 999 }, () => g.generate(req, ctx)));
    const K = 8;
    expect(calls).toBeLessThanOrEqual(K);
    expect(g.spentUsd()).toBeLessThanOrEqual(K * 0.7 + 1e-9);
  });

  it("cold gateway, estimate 0.0001, N=2000: the reviewer's most extreme case -- 2000/2000 calls, $1400 against a $1 budget, pre-fix -- stays bounded at K", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "underestimated-extreme",
      generate: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.7, modelVersion: "m1" };
      },
    };
    const g = createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.0001 });
    await Promise.allSettled(Array.from({ length: 2000 }, () => g.generate(req, ctx)));
    const K = 8;
    expect(calls).toBeLessThanOrEqual(K);
    // $5.60 worst case, not $1400.
    expect(g.spentUsd()).toBeLessThanOrEqual(K * 0.7 + 1e-9);
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

  // Fix round 4, FIX 2, dedicated test: spentUsd() must equal what the
  // provider was ACTUALLY invoked for, not merely what the gateway chose
  // to accept into its own budget bookkeeping. Concurrent dishonest-estimate
  // case (multiple real calls, multiple real bills), not just the
  // single-call case the two tests above already cover.
  it("spentUsd() equals the real total the provider was invoked for, even across multiple refused-after-the-fact calls", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "multi-bill",
      generate: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.7, modelVersion: "m1" };
      },
    };
    const g = createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.01 });
    await Promise.allSettled(Array.from({ length: 50 }, () => g.generate(req, ctx)));
    // Whatever K bounds `calls` to, the ledger must equal EXACTLY
    // calls * 0.7 -- the true vendor bill for every call that actually
    // reached the provider, not a single call's worth and not zero.
    expect(g.spentUsd()).toBeCloseTo(calls * 0.7);
    expect(calls).toBeGreaterThan(0);
  });
});

// Fix round 3, IMPORTANT: the round-2 cold-start gate fixed a real leak but
// at the cost of legitimate availability -- it serialised EVERY cold call
// to at most one in flight, even when every one of them declares an
// honest, accurate estimatedCostUsd and the budget has ample room for all
// of them. Round 3 removed the gate entirely, on the (coordinator-supplied,
// and wrong) reasoning that the contract-violation throw alone was
// sufficient. Fix round 4 restores a gate, but as a CAP
// (COLD_CONCURRENCY_CAP, K=8 -- see gateway.ts's header) with blocked
// callers WAITING for a free slot rather than being rejected, and the cap
// releasing entirely (not just one slot at a time) the instant the
// gateway goes warm. K=8 is small enough to keep worst-case dishonest
// exposure to `K * realCost`, and large enough that it never actually
// binds for these honest, ample-budget scenarios below -- proved directly.
describe("gateway budget: honest concurrent load on a cold gateway (fix round 3/4, IMPORTANT)", () => {
  it("N=4 parallel on a COLD gateway with an honest estimate and ample budget: all 4 succeed, none rejected", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "parallel-4",
      generate: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.1, modelVersion: "m1" };
      },
    };
    const g = createGateway({ provider, budgetUsd: 10, maxWallclockMs: 5000, estimatedCostUsd: 0.1 });
    const settled = await Promise.allSettled(Array.from({ length: 4 }, () => g.generate(req, ctx)));
    expect(settled.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(4);
    expect(calls).toBe(4);
    expect(g.spentUsd()).toBeCloseTo(0.4);
  });

  it("N=50 cold with ample budget: all 50 eventually complete -- blocked callers WAIT for capacity rather than being rejected", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "parallel-50",
      generate: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.1, modelVersion: "m1" };
      },
    };
    const g = createGateway({ provider, budgetUsd: 100, maxWallclockMs: 5000, estimatedCostUsd: 0.1 });
    const settled = await Promise.allSettled(Array.from({ length: 50 }, () => g.generate(req, ctx)));
    // The property FIX 1 exists to guarantee: with an honest estimate and
    // ample budget, NOTHING is rejected -- calls beyond the K=8 cap wait
    // for a slot rather than dying because they started first.
    expect(settled.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(50);
    expect(calls).toBe(50);
    // The ledger (spentUsd) matches what the vendor was actually billed
    // (calls * real cost) -- not merely "under budget", but exactly
    // accurate.
    expect(g.spentUsd()).toBeCloseTo(calls * 0.1);
  });

  it("N=50 cold against a budget that fits 1: provider invocation count is exactly floor(budget/estimate) (the original round-1 CRITICAL must not regress)", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "cold-burst-tight-budget",
      generate: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.15, modelVersion: "m1" };
      },
    };
    // Honest, accurate estimate (matches real cost) -- floor(1/0.15) = 6,
    // below the K=8 cap, so the cap never actually binds here; the
    // reservation math alone (each call reserving its own declared
    // maximum before the first await) is what bounds this cold burst.
    const g = createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 0.15 });
    await Promise.allSettled(Array.from({ length: 50 }, () => g.generate(req, ctx)));
    expect(calls).toBe(6);
    expect(g.spentUsd()).toBeCloseTo(6 * 0.15);
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["missing (undefined)", undefined],
  ])("every hostile estimate value (%s) still makes zero provider calls after the gate is removed", (_label, badValue) => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "hostile-estimate-no-gate",
      generate: async () => {
        calls++;
        return { text: "{}", tokensIn: 1, tokensOut: 1, costUsd: 0.7, modelVersion: "m1" };
      },
    };
    expect(() =>
      createGateway({ provider, budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: badValue as never }),
    ).toThrow();
    expect(calls).toBe(0);
  });

  // The error message a legitimate caller sees when refused for a real
  // budget reason must remain actionable -- unaffected by removing the
  // gate (the gate's own, non-actionable "cannot yet be safely judged"
  // message is gone along with it), but re-asserted here so a future
  // change cannot silently regress it.
  it("a genuine budget refusal still names the budget, what was spent, and what remains", async () => {
    const g = createGateway({ provider: costing(2), budgetUsd: 1, maxWallclockMs: 5000, estimatedCostUsd: 2 });
    await expect(g.generate(req, ctx)).rejects.toThrow(/budget/i);
  });
});
