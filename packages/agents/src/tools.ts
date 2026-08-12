/**
 * The tool registry is the runtime gate between an agent (and, transitively,
 * any hostile content it read via wrapUntrusted in untrusted.ts) and any
 * effect a tool handler can have. See
 * .superpowers/sdd/2026-08-11-p2-agent-runtime-approval/STANDING-CONTEXT.md:
 * the allowlist is what makes a *successful* prompt injection harmless --
 * even if a hostile page convinces the model to ask for "publish.meta", this
 * is where that request is refused, before the handler ever runs. That is
 * why the check happens here, in code the model cannot influence, rather
 * than as an instruction inside a prompt.
 *
 * Two hardening decisions beyond the brief's reference implementation:
 *
 * 1. Tool names are matched with plain `===` (via Array#includes and
 *    Map#get) -- no case-folding, trimming, or Unicode normalisation
 *    anywhere in this file. That is deliberate: normalising names would
 *    itself become an attack surface (a name that *normalises onto* an
 *    allowlisted one, but was never explicitly allowlisted, would need to be
 *    treated as a bypass). Exact-match-only means the burden is on whoever
 *    builds the allowlist to spell it correctly, not on this file to guess
 *    which spellings "really" mean the same tool.
 * 2. Registering the same tool name twice throws at construction, so which
 *    handler would run is never a question -- there is no "last one wins"
 *    to reason about.
 */
import type { Id } from "@smos/domain";
import { logger } from "@smos/telemetry";
import { withTenantTools, type ToolTx } from "@smos/db";

// The refused name is attacker-influenced (it is exactly what the model
// asked for), so logging it verbatim is an unbounded log-volume vector -- a
// multi-megabyte tool name would be written to the log in full. Capped well
// below anything a real tool name needs, and marked so a reader
// investigating an incident (Task 11's whole point) knows the value was cut
// rather than genuinely this short. The full name is never assembled into
// the logged fields at all -- not truncated for display and left elsewhere
// in the same log line -- so it cannot leak out through a sibling field.
const MAX_LOGGED_TOOL_NAME_LENGTH = 200;

function truncateForLog(value: string, max = MAX_LOGGED_TOOL_NAME_LENGTH): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated, ${value.length} chars total]`;
}

export interface ToolContext {
  workspaceId: Id;
  agentRunId: Id;
  allowlist: string[];
}

export interface ToolDef {
  name: string;
  handler: (args: unknown, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolRegistry {
  invoke(name: string, args: unknown, ctx: ToolContext): Promise<unknown>;
}

export function createToolRegistry(tools: ToolDef[]): ToolRegistry {
  // Built once, here, from the array as it exists right now: pushing more
  // entries onto the caller's original array afterwards has no effect on
  // this registry (proven in tools.test.ts, "snapshots the tool list").
  //
  // A plain `Map`, not `{}` or `Object.create(null)` skipped either --
  // Map#get on a string key never falls through to anything on a prototype
  // chain, so tool names like "__proto__", "constructor", or "toString"
  // behave as ordinary, almost-certainly-unregistered strings rather than
  // resolving to an inherited object/function (proven in tools.test.ts,
  // "prototype-chain names").
  const byName = new Map<string, ToolDef>();
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(
        `Duplicate tool registration: "${tool.name}" is registered more than once. ` +
          "Registering the same name twice would make it ambiguous which handler runs " +
          "and non-deterministic under refactors, so this is refused outright.",
      );
    }
    byName.set(tool.name, tool);
  }

  return {
    async invoke(name, args, ctx) {
      // The allowlist check runs first and reads ctx.allowlist fresh on
      // every call -- it is never cached or read at construction, because
      // construction never even sees a ToolContext. That is what lets one
      // long-lived registry correctly enforce a *different* allowlist for
      // every run (AgentRegistryEntry.toolAllowlist, built by trusted
      // runtime code, never by model output).
      if (!ctx.allowlist.includes(name)) {
        // A refusal must be visible, not silent -- Task 11's injection
        // corpus and the audit trail both depend on that.
        logger.warn("policy.violation", {
          kind: "tool_not_allowed",
          tool: truncateForLog(name),
          workspaceId: ctx.workspaceId,
          agentRunId: ctx.agentRunId,
        });
        throw new Error(`Tool "${name}" is not on the tool allowlist for this agent`);
      }

      const tool = byName.get(name);
      if (tool === undefined) throw new Error(`Unknown tool "${name}"`);

      // ctx is the only channel the handler receives; it carries
      // workspaceId (so a correctly-written handler can only ever act
      // within its own tenant, see defineTenantTool below) but never a
      // reference back to this registry or to `invoke` itself, so a
      // handler has no way to reach -- and therefore no way to escape the
      // allowlist of -- any other tool (proven in tools.test.ts, "a handler
      // cannot escape its own allowlist").
      return tool.handler(args, ctx);
    },
  };
}

// The pool type is pulled from withTenantTools's own signature instead of
// importing "pg" here directly, so this package does not need "pg" as a
// dependency of its own just to spell this type.
type Pool = Parameters<typeof withTenantTools>[0];

export type TenantToolHandler = (args: unknown, tx: ToolTx, ctx: ToolContext) => Promise<unknown>;

/**
 * Builds a ToolDef whose body can reach the database only through ToolTx
 * (@smos/db's withTenantTools) -- never a raw pg.Pool or full TenantTx, and
 * never any handle wide enough to run arbitrary SQL. See packages/db's
 * tool-tx.ts: ToolTx exists specifically so a tool implementation (layer 1
 * of ADR-007's defence, and the layer most exposed to untrusted content)
 * cannot re-scope itself into another tenant.
 *
 * ToolContext (per task-4-brief.md and every downstream task that consumes
 * it -- runtime.ts/T7, injection.test.ts/T11) is exactly
 * `{ workspaceId, agentRunId, allowlist }`; it has no room for a `tx` or
 * `pool` field, and widening it would ripple into interfaces those tasks
 * already pin. So the pool lives in this function's closure instead, and
 * every call scopes strictly to `ctx.workspaceId` -- the one piece of
 * tenant identity ToolContext *does* carry. A tool author using
 * defineTenantTool never sees the pool or a TenantTx at all, only ToolTx,
 * which makes the safe access path the only path, not merely the
 * recommended one.
 */
export function defineTenantTool(name: string, pool: Pool, handler: TenantToolHandler): ToolDef {
  return {
    name,
    handler: (args, ctx) => withTenantTools(pool, ctx.workspaceId, (tx) => handler(args, tx, ctx)),
  };
}
