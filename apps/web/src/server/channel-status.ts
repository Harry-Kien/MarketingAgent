// P4 Task 9: closes the known cross-track gap documented in
// apps/web/src/server/actions/submit-approval.ts -- `isChannelConnected`
// was a stub that always returned `false` because, when P3 wrote it, there
// was no channel-integration table. 0028_integration.sql has since created
// `integration`; this is the real check against it.
import type pg from "pg";
import { withTenant } from "@smos/db";
import type { Id } from "@smos/domain";

/**
 * "connected" and "sandbox" are the two `integration.status` values that
 * mean something real is actually reachable through this channel today
 * (see apps/web/src/app/(app)/integrations/status.ts's header for what each
 * status value genuinely claims). "disconnected" and "not_implemented" are
 * both refused -- a row existing with the wrong status is not a connection,
 * and neither is no row at all.
 */
const USABLE_STATUSES: ReadonlySet<string> = new Set(["connected", "sandbox"]);

/**
 * Derives the provider from an approval request's `target_channel`
 * ("meta_page" -> "meta"). Meta is the only implemented provider in this
 * milestone (packages/integrations has exactly one adapter), so this simple
 * split is sufficient; must stay consistent with
 * apps/web/src/app/(app)/integrations/status.ts's IMPLEMENTED_PROVIDERS,
 * the single source of truth for which providers exist at all.
 */
export function providerForChannel(targetChannel: string): string {
  const [provider] = targetChannel.split("_");
  return provider !== undefined && provider.length > 0 ? provider : targetChannel;
}

/**
 * T17: whether `targetChannel` is backed by a real, at-least-configured
 * `integration` row in this workspace. No row at all -- the common case for
 * every workspace before its first real connect -- fails closed to `false`,
 * never inferred as connected. Runs inside `withTenant`, so RLS confines
 * the read to `workspaceId` exactly like every other query in this app;
 * another workspace's integration row is invisible here even if this SQL
 * had a bug in its own WHERE clause.
 */
export async function isChannelConnected(pool: pg.Pool, workspaceId: Id, targetChannel: string): Promise<boolean> {
  const provider = providerForChannel(targetChannel);
  const result = await withTenant(pool, workspaceId, (tx) =>
    tx.query(`select status from integration where workspace_id = $1 and provider = $2`, [workspaceId, provider]),
  );
  const row = result.rows[0] as { status: string } | undefined;
  return row !== undefined && USABLE_STATUSES.has(row.status);
}
