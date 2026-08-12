import type { Id } from "@smos/domain";
import { logger } from "@smos/telemetry";
import type { GenerateRequest, GenerateResult, ModelProvider } from "./types.ts";

export interface Gateway {
  generate(req: GenerateRequest, ctx: { workspaceId: Id; agentRunId: Id }): Promise<GenerateResult>;
  spentUsd(): number;
}

export interface GatewayDeps {
  provider: ModelProvider;
  budgetUsd: number;
  maxWallclockMs: number;
  /**
   * The MAXIMUM a single call to `provider` may ever cost -- not a typical
   * or average value (fix round 2, CRITICAL: a caller that declared a
   * "typical" 0.01 against a real cost of 0.70 is not making an honest
   * estimate, it is violating this contract on its very first call).
   * Validated at construction (finite, > 0) so a gateway with a missing,
   * zero, negative, NaN or infinite estimate is impossible to build --
   * TypeScript typing alone is not enough, since an un-typechecked JS
   * caller can pass anything at runtime. Used as the pre-call reservation
   * whenever it exceeds the real high-water mark this gateway has actually
   * observed (`maxCostSeen`), which on a gateway that has never yet made a
   * call is always the case (maxCostSeen starts at 0). Over-estimating
   * merely refuses a call sooner than strictly necessary; under-estimating
   * is the failure mode this field, plus the contract-violation check and
   * the cold-start concurrency cap below, exist to close.
   */
  estimatedCostUsd: number;
}

/**
 * Hard cap on how many calls may be concurrently in flight while this
 * gateway has never yet observed a real cost from its provider
 * (`maxCostSeen === 0`). Fix round 4, FIX 1 -- see the module header for
 * why this exists and why it is a small constant rather than 1 (round 2)
 * or absent entirely (round 3).
 */
const COLD_CONCURRENCY_CAP = 8;

/**
 * The gateway is the only place a model call can happen (R1). Its budget is
 * the mechanism that stops an agent loop from spending real money overnight,
 * so every decision here is biased toward "refuse and stay put" over
 * "proceed and hope".
 *
 * Cost is only known once a provider call returns -- `GenerateRequest`
 * carries no price hint, so a truly *first-ever* call to a provider cannot
 * be judged against the budget before it happens; there is nothing yet to
 * judge it against. What the gateway *can* do, and does, is remember the
 * worst per-call cost it has ever observed from this provider (a
 * high-water mark) and treat that as a conservative reservation for the
 * next call: if spent-so-far plus that reservation would blow the budget,
 * the next call is refused before the provider is ever invoked.
 *
 * Three defences, across four rounds of review:
 *
 * 1. (Fix round 1) `estimatedCostUsd` gives the reservation a non-zero
 *    floor even before any real cost is known, closing the original
 *    $0-reservation cold-start leak.
 * 2. (Fix round 2) A CONTRACT check: `estimatedCostUsd` is documented as
 *    the maximum a call may cost, so a real cost that exceeds it is a
 *    caller error, not routine variance. `maxCostSeen` is updated to the
 *    real value regardless (so no *subsequent* reservation can keep
 *    under-reserving), but the call itself still throws: silently
 *    absorbing a violated safety contract is exactly how the original
 *    finding stayed invisible for a full fix round. This check alone
 *    CANNOT substitute for a concurrency cap (see 3): it fires strictly
 *    AFTER the provider has already been called and already billed real
 *    money for that one call -- it disciplines what happens next, not
 *    what already happened.
 * 3. (Fix round 4, FIX 1) A cold-start concurrency CAP: at most
 *    `COLD_CONCURRENCY_CAP` (8) calls may be in flight at once while
 *    `maxCostSeen === 0`. History of this specific defence:
 *      - Round 2 introduced a hard cap of 1 (a serialiser), to bound a
 *        concurrent burst against a caller who under-declared
 *        `estimatedCostUsd`: every call in the burst would otherwise
 *        reserve the SAME too-low number before any of them could prove it
 *        wrong (defence 2 only fires after the fact).
 *      - Round 3 removed it, on the reasoning that defence 2's contract
 *        check made the exposure "loud, not silent". That reasoning
 *        conflated "loud" with "bounded" -- the round-3 reviewer measured
 *        the re-opened exposure directly: N=50 cold at a genuinely
 *        under-declared estimate (0.01 vs a real 0.70) let all 50 through
 *        again ($35 against a $1 budget, byte-identical to the original,
 *        pre-round-1 bug); at estimate 0.0001 and N=2000, ALL 2000 calls
 *        went through ($1400 against a $1 budget). The exposure is
 *        `budget * (realCost / estimate)` -- unbounded as the declared
 *        estimate shrinks, regardless of N, because defence 2 can only
 *        flag a call after the vendor has already been billed for it.
 *      - Round 4 restores the cap, but sized as a small constant (K=8)
 *        rather than round 2's hard 1, and WAITING rather than rejecting:
 *        a legitimate run must never die merely because it started first.
 *        K=8 was chosen because it preserves every honest, ample-budget
 *        scenario measured (N=4 -> 4/4; N=50 with ample budget -> all 50
 *        eventually complete, briefly capped at 8 concurrent) while
 *        bounding worst-case DISHONEST exposure to `K * realCost` --
 *        $5.60, not $1400, regardless of how small the declared estimate
 *        is or how large the concurrent burst is. The cap applies ONLY
 *        while `maxCostSeen === 0`: the instant any real cost is observed
 *        (success or a validly-costed-but-refused call), every waiter is
 *        released at once and the cap never applies again for this
 *        gateway instance -- from then on the reservation math alone
 *        (defence 1) is what bounds concurrency, using the now-corrected
 *        `maxCostSeen`, not the caller's original (possibly dishonest)
 *        estimate.
 *
 * Fix round 4, FIX 2: `spentUsd()` reports the REAL total the provider was
 * actually billed for, not merely the calls the gateway's own bookkeeping
 * chose to "accept". A call that reached the provider is billed the moment
 * it returns a valid cost, regardless of what the gateway decides to do
 * with that information afterward (refuse it as over-budget, flag it as a
 * contract violation, or accept it outright) -- refusing a call after the
 * fact cannot un-spend money that was already spent. `runAgent` persists
 * this value into `agent_run.cost_usd`, so under-reporting it here would
 * make the audit record lie about what a founder was actually billed.
 *
 * Every budget comparison below is written so a non-finite value (NaN,
 * Infinity) fails CLOSED: `x > remaining` returning `false` for `x = NaN`
 * is precisely how a NaN estimate made the original bug permanent rather
 * than merely a cold-start window (reproduced live: 200/200 sequential
 * calls reached the provider once `estimatedCostUsd` was NaN, because the
 * refusal branch could structurally never become true again). Construction
 * validation now makes that specific value impossible to pass in as
 * `estimatedCostUsd`, but every comparison is still written
 * positively-verified-safe rather than negatively-excluded, as a second,
 * independent layer.
 */
export function createGateway(deps: GatewayDeps): Gateway {
  if (!Number.isFinite(deps.estimatedCostUsd) || deps.estimatedCostUsd <= 0) {
    throw new Error(
      `createGateway requires a finite estimatedCostUsd greater than 0 -- it is the MAXIMUM a ` +
        `single call to the provider may ever cost, and a missing, zero, negative, NaN or ` +
        `infinite value would silently defeat the pre-call budget reservation entirely. Got: ${String(deps.estimatedCostUsd)}.`,
    );
  }

  let spent = 0;
  let maxCostSeen = 0;
  let reserved = 0;

  // Fix round 4, FIX 1: cold-start concurrency cap state. `coldInFlight`
  // only has meaning while `maxCostSeen === 0`; `waiters` holds resolve
  // callbacks (plus their timeout handles) for calls blocked on capacity.
  let coldInFlight = 0;
  const waiters: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  /**
   * Resolves once this call may proceed. Returns `true` if the caller now
   * holds a cold-concurrency slot (and must release it via
   * `releaseColdSlot`), or `false` if the gateway is already warm and no
   * cap applies at all. Bounded by `deps.maxWallclockMs` -- the same
   * budget a real model call gets -- so a hung "first" call can never
   * stall every later one indefinitely; timing out here FAILS CLOSED (the
   * caller is refused, exactly like any other budget-shaped refusal,
   * never silently let through).
   */
  async function acquireColdSlot(): Promise<boolean> {
    if (maxCostSeen !== 0) return false;
    if (coldInFlight < COLD_CONCURRENCY_CAP) {
      coldInFlight++;
      return true;
    }
    await new Promise<void>((resolve, reject) => {
      const entry: { resolve: () => void; timer: ReturnType<typeof setTimeout> } = {
        resolve: () => {
          clearTimeout(entry.timer);
          resolve();
        },
        timer: setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) {
            waiters.splice(idx, 1);
            reject(
              new Error(
                `Model call refused: waited ${deps.maxWallclockMs}ms for cold-start capacity ` +
                  `(at most ${COLD_CONCURRENCY_CAP} calls may establish this provider's real cost ` +
                  `concurrently) without a slot becoming free. Retry once other in-flight calls ` +
                  `have completed.`,
              ),
            );
          }
          // idx === -1: already handed a slot directly by releaseColdSlot
          // in the same tick the timer fired -- that resolve() already ran
          // (and cleared this timer), so there is nothing left to do here.
        }, deps.maxWallclockMs),
      };
      waiters.push(entry);
    });
    return true;
  }

  /** Releases a cold-concurrency slot this call was holding, if any. */
  function releaseColdSlot(held: boolean): void {
    if (!held) return;
    if (maxCostSeen !== 0) {
      // Now warm: the cap no longer applies to anyone. Release every
      // waiter at once rather than one at a time -- there is no reason to
      // make the rest queue further once a real cost is known.
      coldInFlight = 0;
      while (waiters.length > 0) {
        waiters.shift()!.resolve();
      }
      return;
    }
    const next = waiters.shift();
    if (next) {
      next.resolve(); // hand the slot directly to the next waiter
    } else {
      coldInFlight--;
    }
  }

  return {
    spentUsd: () => spent,

    async generate(req, ctx) {
      const holdingColdSlot = await acquireColdSlot();

      try {
        const committed = spent + reserved;
        const remaining = deps.budgetUsd - committed;
        // The reservation this call claims: the worst of "what this gateway
        // has actually observed this provider cost before" and "the
        // caller's declared maximum" -- on a cold gateway (maxCostSeen ===
        // 0, true for every call until the first one returns) this is
        // always deps.estimatedCostUsd, which fix round 2 made a
        // validated, enforced maximum. Combined with the cold-start cap
        // above, at most COLD_CONCURRENCY_CAP calls can ever reserve
        // against an as-yet-unverified estimate at once.
        const reservation = Math.max(maxCostSeen, deps.estimatedCostUsd);

        // Fail CLOSED by default: proceed only if every value in this
        // decision is positively verified finite and safe. A naive
        // `remaining <= 0 || reservation > remaining` fails OPEN for a
        // non-finite `reservation` (NaN compares false in both
        // directions), which is exactly how fix round 1's estimate could
        // be turned into a permanent bypass by a single bad number.
        // estimatedCostUsd can no longer be non-finite (construction
        // validates it) and maxCostSeen can never become non-finite (the
        // invalid-cost check below runs before any assignment to it), so
        // this can never actually trip today -- kept as an explicit,
        // independent second layer rather than trusted-by-construction.
        const safeToProceed =
          Number.isFinite(remaining) &&
          remaining > 0 &&
          Number.isFinite(reservation) &&
          reservation > 0 &&
          reservation <= remaining;

        if (!safeToProceed) {
          const remainingText = Number.isFinite(remaining) ? remaining.toFixed(6) : String(remaining);
          const message = `Run budget of ${deps.budgetUsd} USD exhausted (spent ${spent} USD, reserved ${reserved} USD, ${remainingText} USD remaining)`;
          logger.warn("model call refused: budget exhausted before call", {
            workspaceId: ctx.workspaceId,
            agentRunId: ctx.agentRunId,
            provider: deps.provider.name,
            schemaName: req.schemaName,
            budgetUsd: deps.budgetUsd,
            spentUsd: spent,
            reservedUsd: reserved,
            maxCostSeenUsd: maxCostSeen,
            estimatedCostUsd: deps.estimatedCostUsd,
          });
          throw new Error(message);
        }

        // Reserve synchronously, in the same tick as the check above and
        // before the first `await` -- this is what makes a concurrent
        // second caller see this call's claim on the budget, whether the
        // gateway is warm or cold.
        reserved += reservation;

        try {
          const timeout = new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(new Error(`Model call timed out after ${deps.maxWallclockMs}ms`));
            }, deps.maxWallclockMs);
          });

          // Promise.race does not cancel the loser: if the timeout wins, the
          // provider's own promise keeps running to completion in the
          // background. Nothing here ever attaches follow-up logic to that
          // abandoned promise, so a late result -- however it resolves -- is
          // never observed by this function and can never be counted against
          // the budget after the timeout has already rejected the caller.
          const result = await Promise.race([deps.provider.generate(req), timeout]);

          // A hostile or buggy provider must not be able to corrupt the
          // running total: reject non-finite or negative costs outright
          // rather than letting them reduce `spent` (which would silently
          // refund budget that was never actually available) or feed a
          // bogus reservation. maxCostSeen is NOT touched here, so an
          // invalid actual cost can never poison it -- proved in
          // gateway.test.ts's permanence test: the very next call still
          // sees a working gateway.
          if (!Number.isFinite(result.costUsd) || result.costUsd < 0) {
            logger.error("model call refused: provider returned an invalid cost", {
              workspaceId: ctx.workspaceId,
              agentRunId: ctx.agentRunId,
              provider: deps.provider.name,
              schemaName: req.schemaName,
              costUsd: result.costUsd,
            });
            throw new Error(`Provider "${deps.provider.name}" returned an invalid cost: ${result.costUsd}`);
          }

          maxCostSeen = Math.max(maxCostSeen, result.costUsd);

          // Fix round 4, FIX 2: the provider was just invoked and just
          // billed this real amount -- recorded UNCONDITIONALLY, before
          // any decision about whether to accept or refuse the call, so
          // spentUsd() can never under-report what actually left the
          // building. A subsequent refusal (over-budget or contract
          // violation) stops FUTURE calls; it cannot and must not un-spend
          // money already spent.
          spent += result.costUsd;
          logger.info("model call", {
            workspaceId: ctx.workspaceId,
            agentRunId: ctx.agentRunId,
            provider: deps.provider.name,
            schemaName: req.schemaName,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            costUsd: result.costUsd,
            modelVersion: result.modelVersion,
            spentUsd: spent,
          });

          // Post-call check: the very first call to a provider (or any call
          // that costs more than any call before it) can only be judged
          // after it returns. `spent` already includes this call's real
          // cost (fix round 4, FIX 2) -- this only decides whether to
          // surface a refusal for it, never whether to record it.
          if (spent > deps.budgetUsd) {
            logger.warn("model call refused: result exceeded budget", {
              workspaceId: ctx.workspaceId,
              agentRunId: ctx.agentRunId,
              provider: deps.provider.name,
              schemaName: req.schemaName,
              budgetUsd: deps.budgetUsd,
              spentUsd: spent,
              callCostUsd: result.costUsd,
            });
            throw new Error(
              `Run budget of ${deps.budgetUsd} USD was exceeded by this call (now spent ${spent} USD)`,
            );
          }

          // Fix round 2, CRITICAL, defence 2: estimatedCostUsd is
          // documented as the MAXIMUM a call may cost. maxCostSeen and
          // spent were already updated above, so no subsequent reservation
          // can keep under-reserving regardless of what happens next --
          // this throw exists purely to surface the violation loudly
          // instead of absorbing it silently, per the review finding.
          if (result.costUsd > deps.estimatedCostUsd) {
            const violation =
              `Provider "${deps.provider.name}" returned costUsd=${result.costUsd}, exceeding the ` +
              `declared estimatedCostUsd=${deps.estimatedCostUsd} (the declared MAXIMUM a single ` +
              `call may cost). This is a contract violation, not routine variance: raise ` +
              `estimatedCostUsd for this provider/model. The real spend has still been recorded.`;
            logger.error("model call violated its declared cost ceiling", {
              workspaceId: ctx.workspaceId,
              agentRunId: ctx.agentRunId,
              provider: deps.provider.name,
              schemaName: req.schemaName,
              costUsd: result.costUsd,
              estimatedCostUsd: deps.estimatedCostUsd,
            });
            throw new Error(violation);
          }

          return result;
        } finally {
          // Reconciled on every exit path -- success, provider throw, invalid
          // cost, over-budget result, contract violation, and timeout -- so a
          // failed or abandoned call can never permanently strand budget that
          // was never spent.
          reserved -= reservation;
        }
      } finally {
        releaseColdSlot(holdingColdSlot);
      }
    },
  };
}
