import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { AppShell } from "../src/ui/AppShell.tsx";
import { PageState } from "../src/ui/PageState.tsx";
import { StateRibbon } from "../src/ui/StateRibbon.tsx";
import { ApprovalDecisionForm } from "../src/ui/ApprovalDecisionForm.tsx";
import { t } from "../src/i18n/index.ts";

const TOKENS_CSS_PATH = fileURLToPath(new URL("../src/ui/tokens.css", import.meta.url));

/**
 * E11 keyboard/a11y evidence harness.
 *
 * `@playwright/test` and `@axe-core/playwright` are not installed in this
 * workspace (checked: absent from every package.json and package-lock.json
 * in the repo) and the brief forbids adding a new npm dependency to a
 * shared lockfile. The real (app) routes cannot be driven live either:
 * every one of them sits behind `requireWorkspace()`, which is a
 * documented stub that always throws until a real session backend lands
 * (see `apps/web/src/server/auth.ts`) -- so today they render nothing but
 * the `unauthorized` PageState, with no nav rail, no command bar, and no
 * approval form to press Tab through.
 *
 * This harness is the closest available substitute: it renders the ACTUAL
 * production components (not look-alikes) -- `AppShell` (the real left
 * rail + command bar), `StateRibbon`, `PageState` (with a retry
 * affordance), and `ApprovalDecisionForm` (the exact same component
 * `approvals/[id]/page.tsx` now imports and renders) -- to one static HTML
 * document, with the real generated `tokens.css` inlined so computed
 * styles (colour, focus outline) match production. `apps/web/e2e/
 * harness.test.tsx` exercises this through `react-dom/server`, and a
 * Playwright MCP browser session (available in this environment as a tool,
 * not an npm dependency) opens the resulting file directly to drive real
 * Tab/Shift+Tab/Escape key presses and read real computed styles -- see
 * the Tasks 10-11 report for the transcript of that session and exactly
 * what it proved.
 *
 * Disclosed limit: this harness has no client-side JavaScript attached (no
 * `hydrateRoot`), so activating the retry button or submitting the
 * decision form does not actually invoke their handlers -- only reachability,
 * focus visibility, tab order and Escape behaviour are being proven here,
 * not click/submit side effects, which would need the real session backend
 * this task is explicitly not building.
 */
export function buildHarnessDocument(theme: "light" | "dark"): string {
  const tokensCss = readFileSync(TOKENS_CSS_PATH, "utf8");
  const body = renderToStaticMarkup(
    <AppShell pendingApprovals={2}>
      <h1 className="font-display" style={{ lineHeight: "var(--lh-heading)" }}>
        {t("approval.pendingTitle")}
      </h1>
      <p>
        <StateRibbon state="WAITING_APPROVAL" />
      </p>
      <PageState kind="error" detail="harness fixture" onRetry={() => {}} />
      <ApprovalDecisionForm action={() => {}} />
    </AppShell>,
  );

  return `<!doctype html>
<html lang="vi" data-theme="${theme}">
<head>
<meta charset="utf-8" />
<title>E11 keyboard harness (${theme})</title>
<style>${tokensCss}
body { margin: 0; background: var(--color-paper); color: var(--color-ink); font-family: var(--font-body); }
</style>
</head>
<body>${body}</body>
</html>`;
}
