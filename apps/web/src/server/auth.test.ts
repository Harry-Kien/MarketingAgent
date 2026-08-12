// Proves apps/web/src/server/auth.ts's real wiring against real better-auth
// + real Postgres -- no mocked RLS, no mocked session backend. Covers both
// halves resolveWorkspace depends on (session -> userId, userId ->
// workspaceId) plus the adversarial cases the task brief calls out by name:
// a forged session token, a replayed expired session, a client-supplied
// workspace id (even carried by a REAL signed-in session), and sign-up
// being unreachable through the running app's own instance.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId, type Id } from "@smos/domain";
import { createDbPool } from "@smos/db";
import { auth, buildSessionDeps } from "./auth.ts";
import { adminAuth } from "./auth-admin.ts";
import { resolveWorkspace, UnauthorizedError } from "./session.ts";

const adminUrl =
  process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);

interface Fixture {
  workspaceId: Id;
  userId: Id;
  email: string;
  password: string;
}

const createdUserIds: Id[] = [];
const createdWorkspaceIds: Id[] = [];

/**
 * Provisions a real user (via the admin-mode, sign-up-enabled instance --
 * apps/web/src/server/auth-admin.ts) with a real hashed password, binds it
 * to a fresh workspace via workspace_member, exactly the administrative
 * path 0030_user_account_no_app_write.sql requires (smos_app itself can
 * never do this). Password is synthetic and unique per call (`newId()`),
 * never a fixed literal.
 */
async function seedSignedUpUser(label: string): Promise<Fixture> {
  const workspaceId = newId();
  const email = `auth-test-${label}-${newId()}@test.local`;
  const password = `Test-Pw-${newId()}!`;

  await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [workspaceId, `auth-test-${label}-${workspaceId}`]);

  const signUpResult = await adminAuth.api.signUpEmail({ body: { email, password, name: label } });
  const userId = signUpResult.user.id as Id;
  createdUserIds.push(userId);
  createdWorkspaceIds.push(workspaceId);

  await adminPool.query(`insert into workspace_member (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`, [
    newId(),
    workspaceId,
    userId,
  ]);

  return { workspaceId, userId, email, password };
}

/** Signs in through the REAL app instance (auth.ts's `auth`, disableSignUp: true) and returns a Headers carrying the real session cookie a browser would send back. */
async function signInAndGetCookieHeaders(email: string, password: string): Promise<Headers> {
  const { headers: responseHeaders } = await auth.api.signInEmail({
    body: { email, password },
    returnHeaders: true,
  });
  const setCookie = responseHeaders.get("set-cookie");
  expect(setCookie, "sign-in must set a session cookie").not.toBeNull();
  const cookiePair = (setCookie as string).split(";")[0] as string;
  return new Headers({ cookie: cookiePair });
}

afterAll(async () => {
  // session/account cascade off user_account (0029_auth_schema.sql:
  // ON DELETE CASCADE); workspace_member has no cascade and must go first.
  for (const workspaceId of createdWorkspaceIds) {
    await adminPool.query("delete from workspace_member where workspace_id = $1", [workspaceId]).catch(() => undefined);
  }
  for (const userId of createdUserIds) {
    await adminPool.query("delete from user_account where id = $1", [userId]).catch(() => undefined);
  }
  for (const workspaceId of createdWorkspaceIds) {
    await adminPool.query("delete from workspace where id = $1", [workspaceId]).catch(() => undefined);
  }
  await adminPool.end();
});

describe("real session -> real workspace, end to end", () => {
  it("a real signed-in session resolves to the workspace its user belongs to", async () => {
    const a = await seedSignedUpUser("resolve-a");
    const cookieHeaders = await signInAndGetCookieHeaders(a.email, a.password);
    const deps = buildSessionDeps(cookieHeaders);

    const session = await deps.getSession();
    expect(session).toEqual({ userId: a.userId });

    const workspaceId = await deps.lookupWorkspace(a.userId);
    expect(workspaceId).toBe(a.workspaceId);

    const resolved = await resolveWorkspace(deps);
    expect(resolved).toEqual({ userId: a.userId, workspaceId: a.workspaceId });
  });

  it("two independently signed-in users resolve to their own, different workspaces", async () => {
    const a = await seedSignedUpUser("two-a");
    const b = await seedSignedUpUser("two-b");
    const depsA = buildSessionDeps(await signInAndGetCookieHeaders(a.email, a.password));
    const depsB = buildSessionDeps(await signInAndGetCookieHeaders(b.email, b.password));

    const resolvedA = await resolveWorkspace(depsA);
    const resolvedB = await resolveWorkspace(depsB);
    expect(resolvedA.workspaceId).toBe(a.workspaceId);
    expect(resolvedB.workspaceId).toBe(b.workspaceId);
    expect(resolvedA.workspaceId).not.toBe(resolvedB.workspaceId);
  });
});

describe("adversarial: a real session cannot be steered into another workspace", () => {
  it("a client-supplied workspace id is ignored even when carried alongside a real, valid session", async () => {
    const a = await seedSignedUpUser("steer-a");
    const b = await seedSignedUpUser("steer-b");
    const depsA = buildSessionDeps(await signInAndGetCookieHeaders(a.email, a.password));

    // The exact shape a compromised or buggy caller might try: a real,
    // valid session for A, plus an attacker-chosen workspaceId for B passed
    // as resolveWorkspace's second, ignored parameter.
    const resolved = await resolveWorkspace(depsA, { workspaceId: b.workspaceId });
    expect(resolved.workspaceId).toBe(a.workspaceId);
    expect(resolved.workspaceId).not.toBe(b.workspaceId);
  });
});

describe("adversarial: forged and expired sessions are refused", () => {
  it("a forged session token (well-formed cookie, no matching row) resolves to no session", async () => {
    const forged = new Headers({ cookie: `better-auth.session_token=${newId()}.forged-signature-not-real` });
    const deps = buildSessionDeps(forged);
    await expect(deps.getSession()).resolves.toBeNull();
    await expect(resolveWorkspace(deps)).rejects.toThrow(UnauthorizedError);
  });

  it("no cookie at all resolves to no session", async () => {
    const deps = buildSessionDeps(new Headers());
    await expect(deps.getSession()).resolves.toBeNull();
    await expect(resolveWorkspace(deps)).rejects.toThrow(UnauthorizedError);
  });

  it("a real session that has since expired is refused (replay of an expired session)", async () => {
    const a = await seedSignedUpUser("expired-a");
    const cookieHeaders = await signInAndGetCookieHeaders(a.email, a.password);

    // Simulate time passing: push the real session's expires_at into the
    // past directly at the database, as an administrator would when
    // investigating -- never through the app's own connection, matching
    // every other admin-only write in this suite.
    const cookiePair = cookieHeaders.get("cookie") as string;
    const rawToken = cookiePair.split("=").slice(1).join("=");
    const tokenValue = decodeURIComponent(rawToken).split(".")[0];
    const updated = await adminPool.query(
      `update session set expires_at = now() - interval '1 day' where token = $1 returning id`,
      [tokenValue],
    );
    expect(updated.rowCount, "the real session row must exist to be expired").toBe(1);

    const deps = buildSessionDeps(cookieHeaders);
    await expect(deps.getSession()).resolves.toBeNull();
    await expect(resolveWorkspace(deps)).rejects.toThrow(UnauthorizedError);
  });
});

describe("adversarial: no public signup through the running app", () => {
  it("the app's own auth instance (disableSignUp: true) refuses sign-up", async () => {
    await expect(
      auth.api.signUpEmail({
        body: { email: `should-never-exist-${newId()}@test.local`, password: `Test-Pw-${newId()}!`, name: "nope" },
      }),
    ).rejects.toThrow();
  });
});
