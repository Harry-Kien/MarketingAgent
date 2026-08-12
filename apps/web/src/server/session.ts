import type { Id } from "@smos/domain";

export class UnauthorizedError extends Error {
  readonly code = "UNAUTHORIZED";
  constructor(message = "Not signed in") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export interface SessionDeps {
  getSession(): Promise<{ userId: Id } | null>;
  lookupWorkspace(userId: Id): Promise<Id | null>;
}

/**
 * The only place a workspaceId is allowed to come from: the server-side
 * session, resolved to a userId, then looked up server-side. The second
 * parameter exists only so a test can prove it is ignored -- a client can
 * never choose its own workspace (Global Constraint: "workspaceId không bao
 * giờ đến từ client", threat T6, invariant 1). Every caller of this module
 * (and every route handler downstream of it) must pass the resulting
 * workspaceId into `withTenant` (@smos/db) rather than trust anything a
 * request carries.
 */
export async function resolveWorkspace(
  deps: SessionDeps,
  _clientSupplied?: unknown,
): Promise<{ userId: Id; workspaceId: Id }> {
  const session = await deps.getSession();
  if (session === null) throw new UnauthorizedError();
  const workspaceId = await deps.lookupWorkspace(session.userId);
  if (workspaceId === null) throw new UnauthorizedError("User belongs to no workspace");
  return { userId: session.userId, workspaceId };
}
