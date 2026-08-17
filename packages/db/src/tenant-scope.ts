import type pg from "pg";
import { isId, type Id } from "@smos/domain";
import { TenantViolationError } from "@smos/domain";

export interface TenantTx {
  query(text: string, values?: unknown[]): Promise<pg.QueryResult>;
}

/**
 * Every database access in the application goes through this. It opens a
 * transaction, drops to the non-BYPASSRLS role, and sets the session
 * variable the RLS policies read. Anything the callback does is therefore
 * confined to one workspace by PostgreSQL itself, not by our SQL (ADR-007).
 *
 * Both `set local role` and `set_config(..., true)` are transaction-local:
 * PostgreSQL unwinds them automatically on COMMIT or ROLLBACK, so a
 * connection handed back to the pool never carries `smos_app` or a stale
 * `app.workspace_id` into the next unrelated request.
 *
 * `set local role smos_app` here is now defensive, not load-bearing: the
 * pool itself connects AS smos_app (DATABASE_URL, ADR-007), which has no
 * BYPASSRLS and is not a superuser, so RLS applies to every connection this
 * function ever gets from `pool.connect()` whether or not this line runs.
 * Previously the pool connected as the `smos` superuser and this line was
 * the only thing narrowing it -- callback code issuing `RESET ROLE` could
 * undo that and reach full superuser access (see task-5-report.md /
 * task-5b-report.md). It stays as a second, redundant layer: cheap
 * insurance if a future connection string is ever misconfigured back to a
 * privileged role.
 */
// The role every scope is opened as. withTenant only ever issues `set local
// role smos_app` (see below) -- this constant is what the boundary check
// below compares `current_user` back against, and it exists so both places
// stay in sync by construction rather than by convention.
const TENANT_ROLE = "smos_app";

/**
 * FINAL WHOLE-BRANCH REVIEW, CRITICAL 1 -- why this is a per-statement
 * guard and not the end-of-callback read-back it replaces.
 *
 * The previous implementation read `current_setting('app.workspace_id')` and
 * `current_user` back ONCE, after `fn` returned, and rolled back if either
 * had drifted. That is a FINAL-VALUE check, and a final-value check cannot
 * see a transient. Proven live against this database, exactly this shape:
 *
 *     set_config('app.workspace_id', B, true)
 *     insert into goal (... B ...)
 *     set_config('app.workspace_id', A, true)   -- put it back
 *     return
 *
 * The session ended holding precisely what withTenant opened it with, the
 * read-back was satisfied, the transaction COMMITTED, and the row landed in
 * workspace B. Every DEFEAT ATTEMPT test that existed left the scope
 * drifted, which is why none of them covered the restore variant.
 *
 * WHAT WAS CHOSEN, AND WHY IT IS NOT ANOTHER READ-BACK. There are only two
 * shapes of fix: observe the change itself, or make re-scoping impossible
 * inside the callback. Making it impossible AT THE DATABASE is not
 * available: `app.workspace_id` is a custom placeholder GUC, which
 * PostgreSQL classifies PGC_USERSET, and parameter ACLs
 * (`GRANT SET ON PARAMETER`, PG15+) are only consulted for SUSET
 * parameters -- so no REVOKE can stop a session from issuing
 * `SET LOCAL app.workspace_id = ...`. Revoking EXECUTE on `set_config`
 * would not help either: the `SET` command does not go through that
 * function. And PostgreSQL exposes no history for a GUC -- there is no
 * counter, no source-of-last-write, nothing a later statement can query to
 * learn that a value was changed and changed back. Any server-side check
 * that runs after `fn` is therefore a final-value check again, defeated by
 * the same three statements.
 *
 * So the change is observed instead, at the finest granularity the client
 * owns: the scope is re-read after EVERY statement the callback issues,
 * through the one handle it has. The hijack is caught by the guard that
 * runs on the `set_config` statement itself, so the write that would have
 * followed never executes -- this PREVENTS the attack rather than merely
 * detecting it afterwards. Three properties make that guard load-bearing
 * rather than advisory:
 *
 *   1. It cannot be swallowed. The first violation is LATCHED. Every later
 *      `tx.query` re-throws it, and COMMIT is refused even if the callback
 *      catches everything and returns normally.
 *   2. It cannot be batched past. A hijack posted as one `set_config(B);
 *      insert; set_config(A)` string would run start to finish with no
 *      statement boundary in between. A parameterised call cannot express
 *      that at all (the extended query protocol refuses multiple commands);
 *      an unparameterised one is caught because node-postgres returns an
 *      ARRAY of results, one per command -- a protocol-level fact, never a
 *      parse of the caller's SQL -- and that is latched as a violation, so
 *      the batch's writes cannot commit.
 *   3. It is not text inspection. Nothing here parses, matches or blocklists
 *      the caller's SQL; the guard reads what the SESSION actually holds
 *      afterwards, so a novel way of writing `SET` gains an attacker
 *      nothing.
 *
 * HONEST LIMITS, stated because the comment this replaces overclaimed and
 * that overclaim is itself part of what the review found:
 *
 *   - A statement is atomic to this guard. ONE statement that re-scopes,
 *     writes and restores WITHIN ITSELF -- a data-modifying CTE calling
 *     `set_config` in one arm -- ends with the scope intact and is not
 *     caught here. Closing that would require the database, not the GUC, to
 *     be the authority: RLS reading a per-transaction anchor that only a
 *     privileged, non-re-entrant SECURITY DEFINER function can set. That is
 *     a rewrite of every policy in the schema plus a per-row lookup on the
 *     read path, and is recorded as the known residual rather than done
 *     silently or claimed as done.
 *   - The guard runs after a statement completes, so it cannot un-see rows a
 *     hijacked read already returned INTO THE CALLBACK'S OWN VARIABLES. What
 *     it does guarantee is that no statement AFTER the hijack runs at all,
 *     that the transaction cannot commit, and that the caller gets a loud
 *     TenantViolationError instead of a silently wrong result.
 *   - Cost: one extra round trip per statement. Deliberate. The alternative
 *     -- skipping the guard for statements whose text "cannot" change a GUC
 *     -- is exactly the text inspection point 3 exists to avoid.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  workspaceId: Id,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!isId(workspaceId)) {
    throw new TenantViolationError("A valid workspace id is required to open a tenant scope");
  }
  const client = await pool.connect();

  // Latched: set by the first violation seen, never cleared. Read before
  // every statement and again before COMMIT, so neither a callback that
  // catches the error nor one that restores the scope afterwards can get a
  // hijacked transaction committed.
  let violation: TenantViolationError | null = null;

  async function assertScopeIntact(where: string): Promise<void> {
    const r = await client.query(
      "select current_setting('app.workspace_id', true) as ws, current_user as u",
    );
    const heldWorkspaceId: string | null = r.rows[0].ws;
    const heldUser: string = r.rows[0].u;
    if (heldWorkspaceId !== workspaceId || heldUser !== TENANT_ROLE) {
      violation ??= new TenantViolationError(
        `Tenant scope hijacked inside withTenant (detected ${where}): opened for workspace ` +
          `"${workspaceId}" as "${TENANT_ROLE}", but the session was holding workspace ` +
          `"${String(heldWorkspaceId)}" as user "${heldUser}". The transaction is rolled back; ` +
          `nothing the callback did was committed, and no further statement was executed.`,
      );
      throw violation;
    }
  }

  try {
    await client.query("begin");
    await client.query(`set local role ${TENANT_ROLE}`);
    await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);

    const result = await fn({
      query: async (text, values) => {
        if (violation !== null) throw violation;
        const r = await client.query(text, values as never);
        // ONE command per call. A parameterised call already cannot carry
        // more (PostgreSQL's extended query protocol refuses "multiple
        // commands into a prepared statement"); an unparameterised one goes
        // through the simple protocol, where a whole `set_config(...B...);
        // insert ...; set_config(...A...)` batch would otherwise run start
        // to finish with no statement boundary in between for the guard
        // below to stand on. node-postgres reports exactly that case by
        // handing back an ARRAY of results, one per command -- a protocol
        // fact, not a parse of the caller's text -- so it is detected here
        // and latched rather than guessed at from the SQL string.
        if (Array.isArray(r)) {
          violation ??= new TenantViolationError(
            `A multi-command batch was issued inside withTenant (workspace "${workspaceId}"): ` +
              `${r.length} commands ran in one statement with no boundary between them for the ` +
              `tenant-scope guard to check. The transaction is rolled back. Issue one command per ` +
              `tx.query call.`,
          );
          throw violation;
        }
        await assertScopeIntact("after a statement issued by the callback");
        return r;
      },
    });

    // Backstop for anything that reached the session without going through
    // the wrapper above (a future `TenantTx` that grows a second method, a
    // callback handed the raw client some other way). Redundant with the
    // per-statement guard for every path that exists today, deliberately
    // kept: it is the check that would still fire if the wrapper were ever
    // bypassed.
    await assertScopeIntact("when the callback returned");
    if (violation !== null) throw violation;

    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
