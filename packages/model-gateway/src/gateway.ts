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
   * Fix round 1, CRITICAL (task-7-report.md): a conservative estimate of
   * what a single call to `provider` might cost, used as the pre-call
   * reservation whenever it exceeds `maxCostSeen` -- which, on a gateway
   * that has never yet made a call, is always (maxCostSeen starts at 0).
   * Required rather than defaulted to 0, which would silently reintroduce
   * the exact bug this field exists to close: a $0 reservation reserves
   * nothing, so a burst of concurrent calls against a cold gateway all pass
   * the pre-call check and all reach the real, paid provider before any of
   * them has returned a real cost to learn from. Deliberately the caller's
   * choice, not a gateway-computed default: only the caller knows roughly
   * what a call to this provider/model/prompt combination tends to cost.
   * Over-estimating merely refuses a call sooner than strictly necessary;
   * under-estimating lets real vendor spend blow through the budget, so
   * callers should round up.
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
 * the next call is refused before the provider is ever invoked. This is
 * what makes repeated or looping calls hard-stop instead of only being
 * noticed after the fact -- the property that matters most here.
 *
 * That check alone is not enough under concurrency: two calls to
 * `generate()` fired back to back both read `spent`/`maxCostSeen` before
 * either call's `await` lands, so both can pass the check and both reach
 * the provider even though only one more call fits in budget -- the
 * ledger stays internally consistent (JavaScript's single-threaded
 * check-then-mutate never lets `spentUsd()` itself exceed the budget) but
 * the vendor is billed twice while the ledger only ever expected one. To
 * close that, the worst-known cost is *reserved* synchronously, in the
 * same tick as the check, before the first `await`. A concurrent second
 * caller then sees the first caller's reservation and refuses before ever
 * reaching the provider. The reservation is released in a `finally` so it
 * cannot be stranded by a throw, a timeout, or the normal success path.
 */
export function createGateway(deps: GatewayDeps): Gateway {
  let spent = 0;
  let maxCostSeen = 0;
  let reserved = 0;

  return {
    spentUsd: () => spent,

    async generate(req, ctx) {
      const committed = spent + reserved;
      const remaining = deps.budgetUsd - committed;

      // Fix round 1, CRITICAL: the reservation this call will make is the
      // worst of "what we've actually observed this provider cost before"
      // and "what the caller told us to conservatively assume before we've
      // observed anything" -- computed BEFORE the pre-call check, so the
      // check judges the same value that gets reserved. On a cold gateway
      // (maxCostSeen === 0, true for every call until the first one
      // returns) this is what keeps the reservation non-zero: previously
      // `reservation = maxCostSeen` was exactly 0 here, so a $0 reservation
      // reserved nothing and an entire concurrent burst passed the pre-call
      // check before any of them had a real cost to compare against
      // (reproduced live: N=50 concurrent against a $1 budget invoked the
      // real provider all 50 times). estimatedCostUsd closes that without
      // serialising every call behind a lock: it only throttles calls made
      // before the gateway has learned a real cost, and even then only to
      // the extent the budget requires -- concurrent calls beyond what
      // estimatedCostUsd-per-call affords are still refused pre-call, but
      // calls that do fit both proceed and reach the provider concurrently
      // (proved in gateway.test.ts's own concurrency tests, unaffected by
      // this change).
      const reservation = Math.max(maxCostSeen, deps.estimatedCostUsd);

      // Pre-call check: refuse before the provider is ever invoked once the
      // budget (net of what's already spent and what concurrent in-flight
      // calls have reserved) is exhausted, or once this call's reservation
      // would no longer fit in what's left. A spy on the provider proves
      // this branch never calls it.
      if (remaining <= 0 || reservation > remaining) {
        const message = `Run budget of ${deps.budgetUsd} USD exhausted (spent ${spent} USD, reserved ${reserved} USD, ${remaining.toFixed(6)} USD remaining)`;
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
      // before the first `await` -- this is what makes a concurrent second
      // caller see this call's claim on the budget.
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
        // bogus reservation.
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
        return result;
      } finally {
        // Reconciled on every exit path -- success, provider throw, invalid
        // cost, over-budget result, and timeout -- so a failed or abandoned
        // call can never permanently strand budget that was never spent.
        reserved -= reservation;
      }
    },
  };
}
