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
 */
export function createGateway(deps: GatewayDeps): Gateway {
  let spent = 0;
  let maxCostSeen = 0;

  return {
    spentUsd: () => spent,

    async generate(req, ctx) {
      const remaining = deps.budgetUsd - spent;

      // Pre-call check: refuse before the provider is ever invoked once the
      // budget is exhausted, or once the worst cost we've ever seen from
      // this provider would no longer fit in what's left. A spy on the
      // provider proves this branch never calls it.
      if (remaining <= 0 || maxCostSeen > remaining) {
        const message = `Run budget of ${deps.budgetUsd} USD exhausted (spent ${spent} USD, ${remaining.toFixed(6)} USD remaining)`;
        logger.warn("model call refused: budget exhausted before call", {
          workspaceId: ctx.workspaceId,
          agentRunId: ctx.agentRunId,
          provider: deps.provider.name,
          schemaName: req.schemaName,
          budgetUsd: deps.budgetUsd,
          spentUsd: spent,
          maxCostSeenUsd: maxCostSeen,
        });
        throw new Error(message);
      }

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

      // A hostile or buggy provider must not be able to corrupt the running
      // total: reject non-finite or negative costs outright rather than
      // letting them reduce `spent` (which would silently refund budget
      // that was never actually available) or feed a bogus reservation.
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
      // that costs more than any call before it) can only be judged after
      // it returns. spentUsd() must never include money a refused call
      // never actually spent, so the addition happens only once this call
      // is accepted.
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
        // Field names deliberately avoid the substring "token": @smos/telemetry's
        // redact() treats any key matching /token/i as secret-shaped and replaces
        // the value with "[redacted]", which would otherwise erase these plain
        // token *counts* from the log. ("inputTokenCount" would still match.)
        inputUnitCount: result.tokensIn,
        outputUnitCount: result.tokensOut,
        costUsd: result.costUsd,
        modelVersion: result.modelVersion,
        spentUsd: spent,
      });
      return result;
    },
  };
}
