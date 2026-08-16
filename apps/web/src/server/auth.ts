import { headers } from "next/headers";
import type { Id } from "@smos/domain";
import { resolveWorkspace, UnauthorizedError } from "./session.ts";
import { auth, buildSessionDeps, createSmosAuth } from "./auth-core.ts";

// Re-exported so every existing importer (the API route handler,
// auth.test.ts, every page under (app)/) keeps working unchanged -- the
// split from auth-core.ts (see that file's own header) is an internal
// reorganization, not a public API change.
export { auth, buildSessionDeps, createSmosAuth };

/**
 * Server-only tenant context for the current request. Every server
 * component / route handler that needs a workspaceId calls this instead of
 * reading one from props, searchParams, or a header -- see Global
 * Constraint "workspaceId không bao giờ đến từ client" and `withTenant`
 * (@smos/db), which every database access must go through with the
 * workspaceId this returns.
 *
 * `headers()` only resolves inside a real Next.js request; calling this
 * function anywhere else (a plain unit test invoking a server component
 * directly, for instance) makes it throw. That failure mode is treated the
 * same as "no session" -- both mean this call has no way to know who is
 * asking -- rather than letting a framework-internal error escape past
 * `requireWorkspace`'s documented contract of "throws UnauthorizedError,
 * nothing else." ((app)/layout.test.tsx calls AppLayout directly outside
 * any real request and keeps passing unchanged against this real wiring
 * precisely because of this conversion.)
 */
export async function requireWorkspace(): Promise<{ workspaceId: Id; userId: Id }> {
  let requestHeaders: Headers;
  try {
    requestHeaders = await headers();
  } catch {
    throw new UnauthorizedError("No request context available to resolve a session");
  }
  return resolveWorkspace(buildSessionDeps(requestHeaders));
}
