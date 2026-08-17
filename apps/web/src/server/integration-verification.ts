import type pg from "pg";
import { withTenant } from "@smos/db";
import { newId, type Id } from "@smos/domain";
import { providerForChannel } from "./channel-status.ts";

/**
 * Late-review IMPORTANT 3, the other half of the fix.
 *
 * `integration.status = 'sandbox'` renders the badge "Sandbox (đã xác minh)"
 * -- "verified" -- and opens the channel gate on the approval path, yet NO
 * production code path had ever written `integration.status` at all. A claim
 * that nothing can earn but anything can assert is worse than a claim that
 * does not exist: this is the one function that can make it, and it can only
 * make it by naming the publication that earned it.
 *
 * It is deliberately not "set the status", it is "record this successful
 * publication as the evidence". The status is a consequence of the evidence,
 * never an argument. Everything that decides whether the evidence is good
 * enough lives in the database
 * (infra/migrations/0033_integration_sandbox_must_be_earned.sql): the cited
 * publication must be in this workspace (composite foreign key), must have
 * actually reached state 'succeeded' with a provider-assigned external_id,
 * and must have gone to a channel belonging to this provider. This function
 * cannot weaken any of that, and a caller passing a publication that did not
 * really succeed gets an exception rather than a badge.
 *
 * Callers: whatever finishes a real sandbox publish. Today that is the
 * Golden Sequence (apps/web/e2e/golden-sequence.test.ts), which is the only
 * thing in this milestone that genuinely exercises the adapter end to end --
 * and which now asserts that the badge only appears after it has.
 */
export async function recordSandboxVerification(
  pool: pg.Pool,
  workspaceId: Id,
  args: { targetChannel: string; publicationId: Id },
): Promise<void> {
  const provider = providerForChannel(args.targetChannel);
  await withTenant(pool, workspaceId, (tx) =>
    tx.query(
      `insert into integration (id, workspace_id, provider, status, verified_publication_id)
       values ($1, $2, $3, 'sandbox', $4)
       on conflict (workspace_id, provider)
       do update set status = 'sandbox', verified_publication_id = excluded.verified_publication_id`,
      [newId(), workspaceId, provider, args.publicationId],
    ),
  );
}
