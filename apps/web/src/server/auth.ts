import type pg from "pg";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { headers } from "next/headers";
import { newId, type Id } from "@smos/domain";
import { resolveWorkspace, UnauthorizedError, type SessionDeps } from "./session.ts";
import { getPool } from "./db.ts";

/**
 * Real authentication (better-auth 1.6.26, pinned exactly per
 * `npm run lint:versions`), adapted to this project's tenancy invariants
 * rather than taken as-is -- infra/migrations/0029_auth_schema.sql's header
 * and 0030's fix-round document exactly where better-auth's defaults would
 * have conflicted with ADR-007/E4 and what won.
 *
 * Schema mapping: better-auth's "user" model is pointed at the existing
 * `user_account` table (modelName), not a new `user` table -- user_account
 * already carries the FK every approval_decision.actor_user_id relies on
 * (P1). Every other model (`session`, `account`, `verification`) keeps its
 * default table name; all four map their camelCase field names onto this
 * schema's snake_case columns explicitly (`fields`), matching
 * 0029_auth_schema.sql's exact column list.
 *
 * `advanced.database.generateId` uses this codebase's own `newId()` (UUID
 * v7) for every row better-auth creates, rather than better-auth's default
 * id shape, so auth rows sort and validate the same way every other id in
 * this system does.
 *
 * `emailAndPassword.disableSignUp: true`: sign-IN works (needed to actually
 * authenticate), but the sign-up endpoint this same instance would
 * otherwise expose at `/api/auth/sign-up/email` is refused outright. This
 * is not merely a product decision (D1.b: "no public signup") -- it is load
 * -bearing for E4 (0030_user_account_no_app_write.sql): smos_app (the role
 * this instance's pool connects as, `getPool()`) has no INSERT on
 * user_account at all, so even without this flag a sign-up attempt would
 * fail at the database. Provisioning a real user is an administrative act,
 * done through DATABASE_MIGRATION_URL, the same way every existing test
 * fixture and `scripts/apply-migrations.mjs` already do it -- see
 * `apps/web/e2e/fixtures/auth-seed.ts` and
 * `apps/web/src/server/auth.test.ts`'s own admin-mode instance.
 */
/**
 * Factory, not a bare `betterAuth({...})` call, so the exact same field
 * mapping backs two DIFFERENT instances that must never be confused:
 * `auth` below (smos_app, sign-up disabled -- what the running app and
 * every real request uses) and the admin-mode instance
 * `apps/web/src/server/auth-admin.ts` builds for test/seed provisioning
 * only (DATABASE_MIGRATION_URL, sign-up enabled). Keeping one definition
 * means the two can never silently drift out of sync with
 * 0029_auth_schema.sql's column names.
 */
export function createSmosAuth(pool: pg.Pool, options: { disableSignUp: boolean }) {
  return betterAuth({
  database: pool,
  baseURL: process.env["BETTER_AUTH_URL"] ?? "http://localhost:3000",
  secret: process.env["BETTER_AUTH_SECRET"],
  emailAndPassword: {
    enabled: true,
    disableSignUp: options.disableSignUp,
  },
  user: {
    modelName: "user_account",
    fields: {
      emailVerified: "email_verified",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  session: {
    fields: {
      userId: "user_id",
      expiresAt: "expires_at",
      ipAddress: "ip_address",
      userAgent: "user_agent",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  account: {
    fields: {
      userId: "user_id",
      accountId: "account_id",
      providerId: "provider_id",
      accessToken: "access_token",
      refreshToken: "refresh_token",
      idToken: "id_token",
      accessTokenExpiresAt: "access_token_expires_at",
      refreshTokenExpiresAt: "refresh_token_expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  verification: {
    fields: {
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  advanced: {
    database: {
      generateId: () => newId(),
    },
  },
    // Must be last (better-auth's own requirement): lets server actions
    // that call auth.api.signInEmail set the session cookie on the
    // outgoing response automatically, without a route handler in the loop.
    plugins: [nextCookies()],
  });
}

/**
 * The instance the running app actually uses: the shared smos_app pool
 * (`getPool()`, DATABASE_URL) and sign-up disabled. See `createSmosAuth`'s
 * own comment for why this must never be the pool test/seed code uses.
 */
export const auth = createSmosAuth(getPool(), { disableSignUp: true });

/**
 * Builds the `SessionDeps` `resolveWorkspace` (apps/web/src/server/
 * session.ts) needs, from a real `Headers` object. Exported separately from
 * `requireWorkspace` so both halves -- "does this session resolve to the
 * right user" and "does this userId resolve to the right workspace" -- can
 * be exercised directly against real Postgres and a real better-auth
 * instance in apps/web/src/server/auth.test.ts, without needing Next's
 * request-scoped `headers()` to be active (which only exists inside a real
 * request). `requireWorkspace` itself stays a thin, effectively untested
 * wrapper around this -- there is nothing left in it to get wrong once both
 * halves are proven.
 */
export function buildSessionDeps(requestHeaders: Headers): SessionDeps {
  return {
    async getSession() {
      const session = await auth.api.getSession({ headers: requestHeaders });
      if (session === null) return null;
      return { userId: session.user.id as Id };
    },
    async lookupWorkspace(userId) {
      // Deliberately NOT withTenant: this is the one call in the whole
      // application that runs BEFORE a workspace is known -- withTenant
      // requires a workspaceId to open a scope with, which is exactly what
      // this is resolving. resolve_user_workspace (0029_auth_schema.sql) is
      // the narrow, reviewed SECURITY DEFINER bridge built for precisely
      // this: it only ever answers "which workspace does THIS trusted
      // user_id belong to" -- userId here always comes from getSession()
      // above (a verified session), never from anything client-supplied.
      const pool = getPool();
      const result = await pool.query("select resolve_user_workspace($1) as workspace_id", [userId]);
      const row = result.rows[0] as { workspace_id: string | null } | undefined;
      return (row?.workspace_id as Id | undefined) ?? null;
    },
  };
}

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
 * nothing else."
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
