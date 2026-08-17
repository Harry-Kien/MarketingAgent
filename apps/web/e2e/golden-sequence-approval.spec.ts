// E7/E14 closes the last Golden Sequence coverage gap, stated precisely by
// the agent that built golden-sequence.test.ts (that file's own header,
// "Hardening task 2" comments in apps/web/e2e/fixtures/seed.ts): the
// sequence signs in for real and resolves a real session, but it still
// calls `parseApprovalFormData` / `recordApprovalDecision` directly rather
// than clicking the actual approval control. Two things therefore stay
// unproven because they only resolve inside a live Next.js request:
//
//   1. `requireWorkspace()`'s own `await headers()` -- the real mechanism
//      that binds an incoming request to a workspace, and the one place a
//      mistake would silently break tenant isolation for every page at
//      once.
//   2. `submitApproval`'s trailing `revalidatePath` calls -- the cache
//      invalidation a founder actually depends on to see their own
//      decision take effect, without a manual reload.
//
// This file drives a REAL Chromium browser (via @playwright/test, against
// the real `next dev` server apps/web/playwright.config.ts's `webServer`
// starts) through the founder's actual path: sign in, open a pending
// approval, click the real "Phê duyệt" button, and observe the SAME
// document update via revalidation -- never a second DB query standing in
// for what the founder would see. It then proves the sandbox publish path
// honours the decision the browser itself just recorded (never a decision
// injected by a fixture), and finally breaks four separate things --
// approval refusal, an absent session, a mismatched workspace, and the
// publish gate's content-hash check -- each on ITS OWN dedicated test, to
// prove this suite can go red, not just stay green (the standing worry
// throughout this project since a reviewer once left the whole sequence
// green by gutting `handleIngestEvent`).
//
// Discovered live while building this file, fixed as part of it (not
// merely documented around): `apps/web/src/server/actions/submit-approval.ts`
// starts with `"use server"`, and Next.js's Server Actions compiler refuses
// to build the app AT ALL unless every exported function in such a file is
// `async` -- `parseApprovalFormData` was a plain synchronous function, and
// visiting `/approvals/[id]` in a real browser 500'd with "Server Actions
// must be async functions", reproduced live, the first time anything
// actually requested that route through Next's own compiler (Vitest never
// applies this transform, so `submit-approval.test.ts` and
// `golden-sequence.test.ts` both stayed green through it). That is exactly
// the class of defect a live-request browser test exists to catch.
import { expect, test, type Page } from "@playwright/test";
import { createDbPool, withTenant } from "@smos/db";
import type { Id } from "@smos/domain";
import { startFakeMetaServer, createMetaAdapter, type FakeMetaServer } from "@smos/integrations";
import { seedWorkspaceWithLogin, cleanupAuthWorkspace, type AuthSeededWorkspace } from "./fixtures/auth-seed.ts";
import {
  seedAgentRegistry,
  runContentPipeline,
  createApprovalRequest,
  configureChannel,
  insertPreparedPublication,
  insertRevisedContentVersion,
  publishToSandbox,
  readPublicationState,
  cleanupWorkspace,
} from "./fixtures/seed.ts";

const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const appUrl = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);
const pool = createDbPool(appUrl);

const workspacesToClean: AuthSeededWorkspace[] = [];

test.afterAll(async () => {
  for (const ws of workspacesToClean) {
    await cleanupWorkspace(adminPool, ws.workspaceId).catch(() => undefined);
    await cleanupAuthWorkspace(adminPool, ws).catch(() => undefined);
  }
  await pool.end();
  await adminPool.end();
});

/** A real, log-in-able workspace with a real pending approval request --
 * every write here uses `newId()`-suffixed values (via seedWorkspaceWithLogin
 * and the content pipeline fixtures), and the workspace is queued for
 * cleanup regardless of how the test that seeded it ends. */
async function seedPendingApproval(label: string, opts: { connectChannel?: boolean } = {}) {
  const ws = await seedWorkspaceWithLogin(adminPool, label);
  workspacesToClean.push(ws);
  const registry = await seedAgentRegistry(adminPool, ws.workspaceId);
  const pipeline = await runContentPipeline(pool, ws, registry);
  const approvalRequestId = await createApprovalRequest(pool, ws, { contentVersionId: pipeline.contentVersionId });
  if (opts.connectChannel !== false) await configureChannel(pool, ws);
  return { ws, registry, pipeline, approvalRequestId };
}

/** A second, independent pending approval request in a workspace
 * `seedPendingApproval` already set up -- BREAK 2 needs two DISTINCT
 * requests (one to prove the captured wire bytes are genuine, a second,
 * still-undecided one to retarget the "no session" probe at) so that
 * `approval_decision`'s own `UNIQUE(approval_request_id)` constraint can
 * never masquerade as the session check refusing the probe. */
async function addPendingApproval(
  ws: AuthSeededWorkspace,
  registry: Awaited<ReturnType<typeof seedAgentRegistry>>,
): Promise<Id> {
  const pipeline = await runContentPipeline(pool, ws, registry);
  return createApprovalRequest(pool, ws, { contentVersionId: pipeline.contentVersionId });
}

async function login(page: Page, ws: AuthSeededWorkspace): Promise<void> {
  await page.goto("/login");
  await page.locator("#login-email").fill(ws.email);
  await page.locator("#login-password").fill(ws.password);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.waitForURL("/");
}

async function decisionIdFor(workspaceId: Id, approvalRequestId: Id): Promise<Id | null> {
  const r = await withTenant(pool, workspaceId, (tx) =>
    tx.query(`select id from approval_decision where approval_request_id = $1 and workspace_id = $2`, [
      approvalRequestId,
      workspaceId,
    ]),
  );
  const row = r.rows[0] as { id: string } | undefined;
  return (row?.id as Id | undefined) ?? null;
}

async function decisionCount(workspaceId: Id, approvalRequestId: Id): Promise<number> {
  const r = await withTenant(pool, workspaceId, (tx) =>
    tx.query(`select count(*)::int as n from approval_decision where approval_request_id = $1 and workspace_id = $2`, [
      approvalRequestId,
      workspaceId,
    ]),
  );
  return (r.rows[0] as { n: number }).n;
}

async function withSandboxServer<T>(fn: (server: FakeMetaServer) => Promise<T>): Promise<T> {
  const server = await startFakeMetaServer();
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

function sandboxAdapter(server: FakeMetaServer) {
  return createMetaAdapter(
    { baseUrl: server.url, pageId: "page-1", token: "sandbox-token", allowedHosts: [new URL(server.url).hostname] },
    server.fetchImpl,
  );
}

/** Only the headers a Server Action replay actually needs -- never the
 * cookie (each caller in this file supplies its own, or none, via which
 * request context it replays through). */
function pickReplayHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["content-type", "next-action", "accept"]) {
    const v = headers[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

test.describe("E7/E14: a real browser drives submitApproval inside a live Next.js request", () => {
  test("approving in a real browser reaches the founder's own UI after revalidation, and the sandbox publish path honours that real decision", async ({
    page,
  }) => {
    const { ws, pipeline, approvalRequestId } = await seedPendingApproval("approve-live");
    await login(page, ws);

    await page.goto(`/approvals/${approvalRequestId}`);
    await expect(page.getByRole("button", { name: "Phê duyệt" })).toBeVisible();

    await page.locator("#approval-reason").fill("Nội dung đã có bằng chứng xác thực và đúng giọng thương hiệu.");
    await page.getByRole("button", { name: "Phê duyệt" }).click();

    // E14: proven by what the founder would see on the SAME document,
    // without a manual reload -- there is no other way this text could
    // appear here except `requireWorkspace()` resolving a real session for
    // this POST and `submitApproval`'s own `revalidatePath(
    // "/approvals/${approvalRequestId}")` re-fetching this route.
    await expect(page.getByText("Yêu cầu này đã được quyết định")).toBeVisible();
    await expect(page.getByRole("button", { name: "Phê duyệt" })).toHaveCount(0);

    // The SECOND revalidatePath call ("/approvals") reaches a DIFFERENT
    // route: the pending list no longer links to this request.
    await page.goto("/approvals");
    await expect(page.locator(`a[href="/approvals/${approvalRequestId}"]`)).toHaveCount(0);

    const approvalDecisionId = await decisionIdFor(ws.workspaceId, approvalRequestId);
    expect(approvalDecisionId).not.toBeNull();

    // Never the DB standing in for the browser proof above -- this is the
    // SEPARATE, later claim the task asks for: that the publish path
    // honours the decision the browser itself produced. Never real Meta,
    // never a real credential -- the fake sandbox server only.
    const publicationId = await insertPreparedPublication(pool, ws, {
      contentVersionId: pipeline.contentVersionId,
      publicationContent: pipeline.publicationContent,
      approvalDecisionId: approvalDecisionId as Id,
    });

    await withSandboxServer(async (server) => {
      await publishToSandbox(pool, ws, publicationId, sandboxAdapter(server));
      const state = await readPublicationState(pool, ws, publicationId);
      expect(state.state).toBe("succeeded");
      expect(server.posts.size).toBe(1);
    });
  });

  test("BREAK 1/4 (approval refused): clicking approve for a disconnected channel fails at the server, not the UI", async ({
    page,
  }) => {
    const { ws, approvalRequestId } = await seedPendingApproval("break-disconnected", { connectChannel: false });
    await login(page, ws);
    await page.goto(`/approvals/${approvalRequestId}`);

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    let postStatus: number | null = null;
    page.on("response", (res) => {
      if (res.request().method() === "POST" && res.url().includes(`/approvals/${approvalRequestId}`)) {
        postStatus = res.status();
      }
    });

    // assertRenderable (the page's own pre-check) only requires evidence +
    // a non-blank target channel, neither of which this is missing -- the
    // form DOES render. The refusal below can only come from
    // performApproval's T17 channel gate running inside the real request.
    await expect(page.getByRole("button", { name: "Phê duyệt" })).toBeVisible();
    await page.locator("#approval-reason").fill("Duyệt dù kênh chưa kết nối.");
    await page.getByRole("button", { name: "Phê duyệt" }).click();
    await page.waitForTimeout(1500);

    expect(postStatus).toBe(500);
    expect(pageErrors.some((m) => m.includes("Kênh đích đang ngắt kết nối"))).toBe(true);
    expect(await decisionCount(ws.workspaceId, approvalRequestId)).toBe(0);
  });

  test("BREAK 2/4 (session absent): a real submission's own bytes, retargeted at a SEPARATE still-pending item and replayed with no session cookie, are refused by the server", async ({
    page,
    browser,
  }) => {
    const { ws, registry, approvalRequestId: item1 } = await seedPendingApproval("break-nosession");
    // A second, still-undecided request in the same workspace -- the probe
    // below targets THIS one, so `approval_decision`'s own
    // UNIQUE(approval_request_id) constraint can never be the thing that
    // refuses it (item1's own decision, from the control click, would
    // already occupy that constraint for item1, masking whether the
    // SESSION check itself did any work at all).
    const item2 = await addPendingApproval(ws, registry);

    await login(page, ws);
    await page.goto(`/approvals/${item1}`);

    let captured: { url: string; headers: Record<string, string>; postData: string } | null = null;
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes(`/approvals/${item1}`)) {
        captured = { url: req.url(), headers: req.headers(), postData: req.postData() ?? "" };
      }
    });

    // Control: item1's own real, legitimate approval -- proves the
    // captured bytes are genuine (not malformed) by actually succeeding.
    await page.locator("#approval-reason").fill("Xác nhận đây là yêu cầu hợp lệ (item1).");
    await page.getByRole("button", { name: "Phê duyệt" }).click();
    await page.waitForTimeout(1000);
    expect(await decisionCount(ws.workspaceId, item1)).toBe(1);

    expect(captured).not.toBeNull();
    const legit = captured as unknown as { url: string; headers: Record<string, string>; postData: string };
    const headers = pickReplayHeaders(legit.headers);
    const tamperedBody = legit.postData.split(item1).join(item2);
    const tamperedUrl = legit.url.replace(item1, item2);

    // The probe: item1's real bytes, retargeted at item2, from a browser
    // context that never logged in at all.
    const anon = await browser.newContext();
    try {
      const refused = await anon.request.post(tamperedUrl, { headers, data: tamperedBody });
      expect(refused.status()).toBeGreaterThanOrEqual(400);
    } finally {
      await anon.close();
    }
    expect(await decisionCount(ws.workspaceId, item2)).toBe(0);
  });

  test("BREAK 3/4 (workspace mismatched) -- cross-tenant probe: workspace A's session cannot approve workspace B's item by driving the request directly", async ({
    page,
    browser,
  }) => {
    const { ws: wsA, approvalRequestId: approvalA } = await seedPendingApproval("break-xtenant-a");
    const { ws: wsB, approvalRequestId: approvalB } = await seedPendingApproval("break-xtenant-b");

    await login(page, wsA);
    await page.goto(`/approvals/${approvalA}`);

    let captured: { url: string; headers: Record<string, string>; postData: string } | null = null;
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes(`/approvals/${approvalA}`)) {
        captured = { url: req.url(), headers: req.headers(), postData: req.postData() ?? "" };
      }
    });

    // A's own real, legitimate approval -- this is what produces the real,
    // validly-encoded request bytes the probe below retargets. It also
    // proves the captured bytes are genuine (not malformed) by actually
    // succeeding for A's own item.
    await page.locator("#approval-reason").fill("Phê duyệt mục của chính workspace A.");
    await page.getByRole("button", { name: "Phê duyệt" }).click();
    await page.waitForTimeout(1000);
    expect(await decisionCount(wsA.workspaceId, approvalA)).toBe(1);

    expect(captured).not.toBeNull();
    const legit = captured as unknown as { url: string; headers: Record<string, string>; postData: string };
    const headers = pickReplayHeaders(legit.headers);
    // The approvalRequestId appears as plain (unencrypted) text in the
    // bound-action arguments on the wire -- Next.js's closure encryption is
    // for values captured by an inline `"use server"` closure, not for
    // `.bind()`'d arguments to a top-level exported action -- so retargeting
    // it is a straightforward substitution of A's real id for B's real id,
    // everything else byte-for-byte identical to what A's own browser sent.
    const tamperedBody = legit.postData.split(approvalA).join(approvalB);
    const tamperedUrl = legit.url.replace(approvalA, approvalB);

    // Driven directly: A's own real session cookie (this browser context's
    // jar), POSTed straight at the endpoint -- never through a page that
    // rendered a button for B's item, because no such page exists (getApprovalRequestDetail
    // is itself workspace-scoped, so /approvals/${approvalB} as A shows
    // "not found", never B's form). The refusal proven below therefore
    // cannot be "the UI hid a button" -- there was no button to hide from;
    // this is the server's own tenant scoping refusing a well-formed
    // request it never should have honoured.
    const res = await page.context().request.post(tamperedUrl, { headers, data: tamperedBody });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(await decisionCount(wsB.workspaceId, approvalB)).toBe(0);

    // Reinforced by what workspace B would actually see: its own item is
    // still exactly as pending as before the attack.
    const contextB = await browser.newContext();
    try {
      const pageB = await contextB.newPage();
      await login(pageB, wsB);
      await pageB.goto(`/approvals/${approvalB}`);
      await expect(pageB.getByRole("button", { name: "Phê duyệt" })).toBeVisible();
      await expect(pageB.getByText("Yêu cầu này đã được quyết định")).toHaveCount(0);
    } finally {
      await contextB.close();
    }
  });

  test("BREAK 4/4 (publish gate): a publication built for a newer, unapproved content version is refused, even though the browser's own approval was real", async ({
    page,
  }) => {
    const { ws, pipeline, approvalRequestId } = await seedPendingApproval("break-hash");
    await login(page, ws);
    await page.goto(`/approvals/${approvalRequestId}`);
    await page.locator("#approval-reason").fill("Nội dung đạt yêu cầu.");
    await page.getByRole("button", { name: "Phê duyệt" }).click();
    await expect(page.getByText("Yêu cầu này đã được quyết định")).toBeVisible();

    const approvalDecisionId = await decisionIdFor(ws.workspaceId, approvalRequestId);
    expect(approvalDecisionId).not.toBeNull();

    // A later edit produces version 2, never itself reviewed by anyone.
    const revisedText = "Bản chỉnh sửa sau khi duyệt: nội dung mới chưa từng được rà soát.";
    const revisedVersionId = await insertRevisedContentVersion(pool, ws, {
      contentItemId: pipeline.contentItemId,
      nextVersionNumber: 2,
      body: revisedText,
      publicationContent: revisedText,
    });
    const publicationId = await insertPreparedPublication(pool, ws, {
      contentVersionId: revisedVersionId, // NOT what approvalDecisionId actually covers
      publicationContent: revisedText,
      approvalDecisionId: approvalDecisionId as Id,
    });

    await withSandboxServer(async (server) => {
      await expect(publishToSandbox(pool, ws, publicationId, sandboxAdapter(server))).rejects.toThrow(
        /content version/i,
      );
      const state = await readPublicationState(pool, ws, publicationId);
      expect(state.state).toBe("prepared"); // never advanced
      expect(server.posts.size).toBe(0); // the adapter was never actually called
    });
  });
});
