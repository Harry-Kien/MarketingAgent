import type { Id } from "@smos/domain";
import { resolveWorkspace, UnauthorizedError, type SessionDeps } from "./session.ts";

/**
 * Wires `resolveWorkspace` to a real session backend. This is intentionally
 * NOT wired to better-auth yet: better-auth is not a dependency of this
 * workspace (adding it here would be a new, unreviewed lockfile change while
 * another track owns the migration sequence this session needs -- a
 * `users`/session table does not exist in `infra/migrations/**` as of this
 * commit), so there is no dependency-free way to turn an incoming request
 * into a real userId today. Rather than fabricate a session (which would be
 * worse than refusing one), `deps` below always reports "no session" until a
 * later task supplies real ones -- e.g. by calling `requireWorkspace` with
 * `deps` overridden once better-auth + a users/workspace_members schema
 * land.
 *
 * What is final regardless of which auth backend eventually lands
 * underneath: `requireWorkspace` takes no request-derived arguments, so it
 * is structurally incapable of reading a workspace id from a query string,
 * request body, header, or cookie value supplied by the client. The only
 * place a workspace id can come from is `deps.lookupWorkspace(userId)`, a
 * server-side call keyed on the session's userId -- never on anything the
 * caller names directly.
 */
const pendingSessionBackend: SessionDeps = {
  getSession(): Promise<{ userId: Id } | null> {
    throw new UnauthorizedError(
      "Session backend is not wired yet (pending better-auth + users schema from another track)",
    );
  },
  lookupWorkspace(): Promise<Id | null> {
    throw new UnauthorizedError(
      "Workspace lookup is not wired yet (pending users/workspace_members schema from another track)",
    );
  },
};

/**
 * Server-only tenant context for the current request. Every server
 * component / route handler that needs a workspaceId calls this instead of
 * reading one from props, searchParams, or a header -- see Global
 * Constraint "workspaceId không bao giờ đến từ client" and `withTenant`
 * (@smos/db), which every database access must go through with the
 * workspaceId this returns.
 */
export async function requireWorkspace(): Promise<{ workspaceId: Id; userId: Id }> {
  return resolveWorkspace(pendingSessionBackend);
}
