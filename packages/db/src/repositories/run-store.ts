// Task 10's file ("RunStore thật trên Postgres", docs/superpowers/plans/
// 2026-08-11-p2-agent-runtime-approval.md), pulled forward into task 7: the
// task's own hard requirement (1) -- "persist the validated output durably,
// within the same transaction that records the run's terminal state" -- is a
// property only a real database connection can have. packages/agents/src/
// runtime.ts's RunStore interface (this file's structural twin, never
// imported directly -- packages/db must not depend on packages/agents) is
// implemented here on top of T6's schema (agent_run, run_checkpoint).
//
// Every write goes through withTenant, so RLS confines it to one workspace
// (D1-3, proved by this file's own "E15" test).
import type pg from "pg";
import { newId, type Id } from "@smos/domain";
import { withTenant } from "../tenant-scope.ts";

export interface RunStore {
  createRun(r: { workspaceId: Id; agentVersionId: Id; campaignId: Id; correlationId: Id }): Promise<Id>;
  checkpoint(runId: Id, step: string, blob: Record<string, unknown>): Promise<void>;
  finishRun(
    runId: Id,
    patch: {
      state: string;
      costUsd: number;
      budgetExceeded: boolean;
      errorCode?: string;
      /**
       * Set only by a caller that already has validated output (see
       * packages/agents/src/runtime.ts: forwarded from `parse()`'s return
       * value on the success path only). Written to
       * run_checkpoint.state_blob -- the one jsonb column T6's schema
       * provides for this purpose -- under the fixed step name
       * "output_persisted", in the SAME withTenant transaction as the
       * agent_run state UPDATE below, so the two can never be observed
       * apart: a crash between them leaves neither committed, and a
       * constraint violation on one rolls back the other (proved in
       * run-store.test.ts, "rolls back the output checkpoint too").
       */
      output?: unknown;
      /**
       * Fix round 1, MINOR: agent_run.tokens_in/tokens_out/wallclock_ms
       * (T6's audit columns, T12's exit criteria) were never written by the
       * original implementation -- only their DEFAULT 0 ever landed.
       * runtime.ts now accumulates real values across every model call a
       * run makes (including every round of a tool-calling loop) and
       * forwards them here on both the success and the failure path, so a
       * run that fails after spending real tokens still records that it
       * did.
       */
      tokensIn?: number;
      tokensOut?: number;
      wallclockMs?: number;
      /**
       * The real model_version the provider actually reported on its last
       * successful call, if any. Left as COALESCE against the existing
       * column value at the SQL layer (not overwritten with a literal) so
       * a run that fails before any call ever returns doesn't lose the
       * 'm1' placeholder createRun seeded it with. prompt_version has no
       * equivalent fix here: nothing in RunAgentInput/buildPrompt's brief-
       * pinned return shape (`{ system, input, schemaName }`) identifies
       * "which prompt template version" independently of schemaName, so
       * inventing a mapping would be guessing, not fixing -- flagged as an
       * open question in task-7-report.md rather than silently papered
       * over.
       */
      modelVersion?: string;
    },
  ): Promise<void>;
  /**
   * Fix round 1, IMPORTANT: one row per tool invocation ATTEMPT a run
   * makes, whether T4's registry allowed it or refused it -- exactly what
   * 0024_agent_run.sql's own header comment says tool_call exists for
   * ("T7's runtime record both, since a refused call is exactly the kind
   * of event an audit trail must not silently omit"), which nothing
   * previously called.
   */
  recordToolCall(
    runId: Id,
    call: { name: string; allowed: boolean; args: unknown; errorCode?: string },
  ): Promise<void>;
}

/** Every write goes through withTenant, so RLS confines the run to one workspace (D1-3). */
export function createRunStore(pool: pg.Pool, workspaceId: Id): RunStore {
  return {
    async createRun(r) {
      const id = newId();
      await withTenant(pool, workspaceId, (tx) =>
        tx.query(
          `insert into agent_run (id,workspace_id,agent_version_id,campaign_id,state,prompt_version,model_version,correlation_id)
           values ($1,$2,$3,$4,'running','p1','m1',$5)`,
          [id, workspaceId, r.agentVersionId, r.campaignId, r.correlationId],
        ));
      return id;
    },

    async checkpoint(runId, step, blob) {
      await withTenant(pool, workspaceId, (tx) =>
        tx.query(
          `insert into run_checkpoint (id,workspace_id,agent_run_id,step_name,state_blob)
           values ($1,$2,$3,$4,$5::jsonb)
           on conflict (agent_run_id, step_name) do nothing`,
          [newId(), workspaceId, runId, step, JSON.stringify(blob)],
        ));
    },

    async finishRun(runId, patch) {
      // Both statements below run against the SAME `tx` handed to this one
      // withTenant callback -- withTenant opens a single `begin`/`commit`
      // around the whole callback (packages/db/src/tenant-scope.ts), so
      // this is one database transaction, not two. That is what makes
      // requirement (1) -- "in the same transaction that records the run's
      // terminal state" -- true by construction rather than by convention.
      await withTenant(pool, workspaceId, async (tx) => {
        await tx.query(
          `update agent_run
           set state=$2, cost_usd=$3, budget_exceeded=$4, error_code=$5,
               tokens_in=$6, tokens_out=$7, wallclock_ms=$8,
               model_version=COALESCE($9, model_version),
               updated_at=now()
           where id=$1`,
          [
            runId,
            patch.state,
            patch.costUsd,
            patch.budgetExceeded,
            patch.errorCode ?? null,
            patch.tokensIn ?? 0,
            patch.tokensOut ?? 0,
            patch.wallclockMs ?? 0,
            patch.modelVersion ?? null,
          ],
        );

        if (patch.output !== undefined) {
          await tx.query(
            `insert into run_checkpoint (id,workspace_id,agent_run_id,step_name,state_blob)
             values ($1,$2,$3,'output_persisted',$4::jsonb)
             on conflict (agent_run_id, step_name) do update set state_blob = excluded.state_blob`,
            [newId(), workspaceId, runId, JSON.stringify({ output: patch.output })],
          );
        }
      });
    },

    async recordToolCall(runId, call) {
      await withTenant(pool, workspaceId, (tx) =>
        tx.query(
          `insert into tool_call (id,workspace_id,agent_run_id,tool_name,allowed,args,error_code)
           values ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
          [
            newId(),
            workspaceId,
            runId,
            call.name,
            call.allowed,
            JSON.stringify(call.args ?? {}),
            call.errorCode ?? null,
          ],
        ));
    },
  };
}
