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
   * is the failure mode this field, plus the contract-violation check
   * below, exist to close: a real cost that exceeds this declared maximum
   * throws loudly rather than being silently absorbed.
   */
  estimatedCostUsd: number;
}

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
 * Two defences work together here, plus a third that was tried and removed
 * (see below), across three rounds of review:
 *
 * 1. (Fix round 1) `estimatedCostUsd` gives the reservation a non-zero
 *    floor even before any real cost is known, closing the original
 *    $0-reservation cold-start leak.
 * 2. (Fix round 2) A CONTRACT check: `estimatedCostUsd` is documented as
 *    the maximum a call may cost, so a real cost that exceeds it is a
 *    caller error, not routine variance. `maxCostSeen` is updated to the
 *    real value regardless (so no *subsequent* reservation can keep
 *    under-reserving -- the safety property holds even if this throw is
 *    never seen by anyone), but the call itself still throws: silently
 *    absorbing a violated safety contract is exactly how the original
 *    finding stayed invisible for a full fix round.
 *
 * Fix round 2 also added a cold-start GATE (at most one call in flight
 * while `maxCostSeen === 0`), to bound a concurrent burst against a caller
 * who under-declared `estimatedCostUsd`. Fix round 3 REMOVES it: with
 * `estimatedCostUsd` now validated at construction and enforced as a
 * genuine maximum (defence 2 above), every in-flight call already reserves
 * an amount that is, by the caller's own declared contract, not less than
 * what that call can cost -- N concurrent calls reserving N * estimate is
 * already the correct bound, via the existing synchronous
 * check-then-reserve below, with no need to observe a real cost first. The
 * gate's actual cost was availability, not safety: measured with an
 * honest, accurate estimate and ample budget, N=4 parallel calls on a cold
 * gateway produced 1 fulfilled and 3 refused with a message that had
 * nothing to do with the caller's real budget. A caller who under-declares
 * the estimate (violating the contract defence 2 exists to police) still
 * gets a loud, individual contract-violation error on every such call --
 * that residual exposure (up to `floor(budget/estimate)` concurrent calls
 * before each is individually flagged, same order of magnitude as before
 * this file had a gate at all) is the accepted trade-off for correct
 * concurrent behaviour in the overwhelmingly common honest case.
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

  return {
    spentUsd: () => spent,

    async generate(req, ctx) {
      const committed = spent + reserved;
      const remaining = deps.budgetUsd - committed;
      // The reservation this call claims: the worst of "what this gateway
      // has actually observed this provider cost before" and "the caller's
      // declared maximum" -- on a cold gateway (maxCostSeen === 0, true
      // for every call until the first one returns) this is always
      // deps.estimatedCostUsd, which fix round 2 made a validated,
      // enforced maximum rather than a mere guess. That is what makes this
      // single synchronous check-then-reserve sufficient on its own (fix
      // round 3): N concurrent cold calls each reserve their own declared
      // maximum before any of them awaits, so N * estimate is already the
      // correct bound on what N of them can legitimately cost -- no
      // separate serialization gate is needed to make that true.
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

        // Post-call check: the very first call to a provider (or any call
        // that costs more than any call before it) can only be judged
        // after it returns. spentUsd() must never include money a refused
        // call never actually spent, so the addition happens only once
        // this call is accepted.
        if (spent + result.costUsd > deps.budgetUsd) {
          logger.warn("model call refused: result would exceed budget", {
            workspaceId: ctx.workspaceId,
            agentRunId: ctx.agentRunId,
            provider: deps.provider.name,
            schemaName: req.schemaName,
            budgetUsd: deps.budgetUsd,
            spentUsd: spent,
            callCostUsd: result.costUsd,
          });
          throw new Error(
            `Run budget of ${deps.budgetUsd} USD would be exceeded by this call (spent ${spent} USD + ${result.costUsd} USD)`,
          );
        }

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

        // Fix round 2, CRITICAL, defence 2: estimatedCostUsd is
        // documented as the MAXIMUM a call may cost. maxCostSeen was
        // already updated above, so no subsequent reservation can keep
        // under-reserving regardless of what happens next -- this throw
        // exists purely to surface the violation loudly instead of
        // absorbing it silently, per the review finding.
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
    },
  };
}
