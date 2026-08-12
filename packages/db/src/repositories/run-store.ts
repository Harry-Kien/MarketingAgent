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

// Fix round 2, MINOR: tool_name and args are attacker-influenced (a model
// chose them) and were otherwise unbounded. Reproduced live: a tool_name
// containing the null control character made the INSERT itself throw an
// "invalid byte sequence for encoding UTF8" error -- PostgreSQL's text
// type cannot store that code point at all, in any column. The tool call
// still failed closed (T4's registry never runs the handler either way),
// but the audit row 0024_agent_run.sql's own header says a refused call
// must never be silently omitted was never written. Sanitised and bounded
// the same way packages/agents/src/tools.ts already truncates a refused
// tool name before logging it (MAX_LOGGED_TOOL_NAME_LENGTH).
const MAX_TOOL_NAME_LENGTH = 200;
// Generous but bounded: args is arbitrary, model-chosen JSON with no
// schema of its own at this layer -- this exists to stop unbounded storage
// growth, not to validate shape.
const MAX_ARGS_JSON_LENGTH = 10_000;

// The one code point PostgreSQL's text type rejects outright. Built via
// String.fromCharCode rather than any escape sequence written directly in
// this file's source, so there is no ambiguity about what character is
// actually present here.
const REJECTED_CONTROL_CHAR = String.fromCharCode(0);

function sanitizeToolNameForStorage(name: string): string {
  // Stripped rather than escaped -- an audit name has no need to preserve
  // the exact rejected byte. `tool_call.tool_name` also carries
  // `CHECK (tool_name ~ '\S')` (0024_agent_run.sql): if stripping leaves
  // nothing at all (a name made only of the rejected character), fall
  // back to a fixed placeholder rather than let the INSERT fail that CHECK
  // instead of the encoding error it replaced.
  const stripped = name.split(REJECTED_CONTROL_CHAR).join("");
  const safe = /\S/u.test(stripped) ? stripped : "[empty-after-sanitization]";
  if (safe.length <= MAX_TOOL_NAME_LENGTH) return safe;
  return `${safe.slice(0, MAX_TOOL_NAME_LENGTH)}...[truncated, ${safe.length} chars total]`;
}

// The textual escape sequence JSON.stringify emits for the rejected
// control character: backslash, u, 0, 0, 0, 0 -- six ordinary characters,
// never a raw control byte. Built from character codes (92 is backslash)
// rather than a source-code escape, for the same reason REJECTED_CONTROL_CHAR
// is above. PostgreSQL's jsonb input function refuses this exact escape
// sequence too ("unsupported Unicode escape sequence"), not only the raw
// byte tool_name is vulnerable to -- discovered when the first version of
// this fix sanitised only tool_name and args still failed the INSERT.
const JSON_ESCAPED_REJECTED_CHAR = String.fromCharCode(92) + "u0000";

function sanitizeArgsJsonForStorage(args: unknown): string {
  const raw = JSON.stringify(args ?? {});
  // Stripped as a literal substring of the JSON TEXT (not a byte-level
  // operation) -- safe to do unconditionally, since this exact six-
  // character sequence can only ever appear here as JSON.stringify's own
  // escape output, never as meaningful application data.
  const json = raw.split(JSON_ESCAPED_REJECTED_CHAR).join("");
  if (json.length <= MAX_ARGS_JSON_LENGTH) return json;
  return JSON.stringify({
    truncated: true,
    originalLength: json.length,
    preview: json.slice(0, 500),
  });
}

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

    // Fix round 2, MINOR: this repository's OWN withTenant call, separate
    // from finishRun's/checkpoint's -- a refused tool call is recorded
    // durably on its own, and does NOT roll back if the run it belongs to
    // later fails for an unrelated reason. This is deliberate, not an
    // oversight: 0024_agent_run.sql's own header says a refused call must
    // never be silently omitted from the audit trail, and "the run that
    // attempted it later failed" is not a reason to un-record that the
    // attempt happened -- if anything, the refused attempt may be exactly
    // WHY the run failed. Measured directly: a refused publish.meta call
    // survives in tool_call even when the surrounding run ends
    // failed_terminal (packages/agents/src/runtime-db.test.ts).
    async recordToolCall(runId, call) {
      const safeName = sanitizeToolNameForStorage(call.name);
      const safeArgsJson = sanitizeArgsJsonForStorage(call.args);
      await withTenant(pool, workspaceId, (tx) =>
        tx.query(
          `insert into tool_call (id,workspace_id,agent_run_id,tool_name,allowed,args,error_code)
           values ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
          [newId(), workspaceId, runId, safeName, call.allowed, safeArgsJson, call.errorCode ?? null],
        ));
    },
  };
}
