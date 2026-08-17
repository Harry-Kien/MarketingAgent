// E7: a real browser, driven by Playwright (@playwright/test 1.62.1,
// pinned exactly per lint:versions), reaches the authenticated console --
// structurally impossible before this task, since every real route sat
// behind requireWorkspace(), which was a stub that always threw
// UnauthorizedError (see the P4 Task 8 report, which explains exactly why
// it built a vitest-only substitute instead of this).
//
// Also proves, at the browser/HTTP level (not just the unit-level proof in
// apps/web/src/server/auth.test.ts and the RLS-level proof in
// packages/db/src/cross-tenant.test.ts): a session authenticated as
// workspace B cannot read workspace A's data through a route, no matter
// what id the URL names.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createDbPool } from "@smos/db";
import { cleanupAuthWorkspace, seedWorkspaceWithLogin, type AuthSeededWorkspace } from "./fixtures/auth-seed.ts";

const adminUrl =
  process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);

// Absolute, not relative to whatever directory `playwright test` happened to
// be invoked from (repo root vs. apps/web both resolve to different things
// for a relative path) -- this file's own location (apps/web/e2e/) is the
// one fixed point.
const ASSETS_DIR = resolve(import.meta.dirname, "../../../docs/research/assets");

let a: AuthSeededWorkspace;
let b: AuthSeededWorkspace;

test.beforeAll(async () => {
  a = await seedWorkspaceWithLogin(adminPool, "a");
  b = await seedWorkspaceWithLogin(adminPool, "b");
  mkdirSync(ASSETS_DIR, { recursive: true });
});

test.afterAll(async () => {
  await cleanupAuthWorkspace(adminPool, a);
  await cleanupAuthWorkspace(adminPool, b);
  await adminPool.end();
});

async function login(page: Page, ws: AuthSeededWorkspace): Promise<void> {
  await page.goto("/login");
  await page.locator("#login-email").fill(ws.email);
  await page.locator("#login-password").fill(ws.password);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.waitForURL("/");
}

test.describe("E7: a real browser reaches the authenticated console", () => {
  test("an unauthenticated request sees the unauthorized state, never the shell", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("status")).toBeVisible();
    await expect(page.locator("nav")).toHaveCount(0);
  });

  test("signing in with real credentials reaches the real shell with this workspace's real data", async ({ page }) => {
    await login(page, a);
    await expect(page.locator("nav")).toBeVisible();
    await expect(page.getByText(a.campaignName)).toBeVisible();
  });

  test("adversarial: workspace B's session cannot read workspace A's campaign through the URL", async ({ page }) => {
    await login(page, b);
    await page.goto(`/campaigns/${a.campaignId}`);
    // E14: reads exactly like "no such campaign", never A's real data and
    // never a distinguishable "wrong workspace" message.
    await expect(page.getByText(a.campaignName)).toHaveCount(0);
    await expect(page.getByText("Không tìm thấy chiến dịch này")).toBeVisible();
  });

  test("adversarial: workspace B's own workspace renders normally (isolation, not just refusal)", async ({ page }) => {
    await login(page, b);
    await page.goto("/");
    await expect(page.getByText(b.campaignName)).toBeVisible();
    await expect(page.getByText(a.campaignName)).toHaveCount(0);
  });

  test("desktop and mobile screenshots for visual review", async ({ page }) => {
    await login(page, a);
    for (const [name, size] of [
      ["desktop", { width: 1440, height: 900 }],
      ["mobile", { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(size);
      for (const path of ["/", "/approvals", "/analytics", `/campaigns/${a.campaignId}`]) {
        await page.goto(path);
        // Wait for the streamed content to replace the loading fallback before
        // capturing. Without this the screenshot catches "Đang tải" and the
        // evidence proves only that a spinner renders -- which is exactly what
        // it did until this assertion was added. Waiting here is also an
        // assertion in its own right: if a page never leaves its loading
        // state, this fails rather than quietly producing a useless image.
        await expect(page.getByText("Đang tải")).toHaveCount(0, { timeout: 15_000 });
        await page.screenshot({
          path: resolve(ASSETS_DIR, `e2e-auth-${name}-${path.replace(/\W+/g, "_")}.png`),
          fullPage: true,
        });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        );
        expect(overflow, `${path} at ${name} must not scroll horizontally`).toBe(false);
      }
    }
  });
});
