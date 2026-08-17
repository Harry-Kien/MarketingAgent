import { requireWorkspace } from "../../server/auth.ts";
import { UnauthorizedError } from "../../server/session.ts";
import { getPool } from "../../server/db.ts";
import { getTodayBoard } from "../../server/queries.ts";
import { PageState } from "../../ui/PageState.tsx";
import { StateRibbon } from "../../ui/StateRibbon.tsx";
import { t } from "../../i18n/index.ts";
import { tokens } from "../../ui/tokens.ts";

/**
 * "Sổ điều hành" -- the operating brief every founder lands on. A server
 * component: `requireWorkspace()` resolves the tenant from the session
 * (never from a route parameter, query string, header or body -- Global
 * Constraint), and `getTodayBoard` runs entirely inside `withTenant`'s
 * scope, so RLS confines the result to this one workspace even if a bug
 * slipped past every layer above it.
 *
 * `(app)/layout.tsx` already renders the `unauthorized` PageState when
 * `requireWorkspace()` throws, but this page calls it again rather than
 * trusting the layout alone: a page must be able to stand on its own if
 * ever rendered outside that layout (a test, a future route restructure),
 * and the call is cheap (an in-memory throw against the stub backend, not a
 * second round trip once a real session backend lands).
 */
export default async function TodayPage() {
  let workspaceId;
  try {
    ({ workspaceId } = await requireWorkspace());
  } catch (error) {
    if (error instanceof UnauthorizedError) return <PageState kind="unauthorized" />;
    throw error;
  }

  let board;
  try {
    board = await getTodayBoard(getPool(), workspaceId);
  } catch {
    // A DB-level failure here is exactly the "error" PageState's job, not a
    // 500 with a stack trace: the founder sees a labelled, recoverable
    // failure instead of a blank page.
    return <PageState kind="error" />;
  }

  if (board.campaigns.length === 0) {
    return <PageState kind="empty" />;
  }

  return (
    <div>
      <h1 className="font-display" style={{ lineHeight: "var(--lh-heading)", margin: 0 }}>
        {t("home.title")}
      </h1>
      <p style={{ color: "var(--color-ink2)", lineHeight: "var(--lh-body)" }}>{t("home.briefTitle")}</p>
      {board.pendingApprovalCount > 0 && (
        <p style={{ color: "var(--color-tho)", lineHeight: "var(--lh-body)" }}>
          {t("home.needsYou")}: {t("approval.pendingCount", { count: board.pendingApprovalCount })}
        </p>
      )}
      {/* overflow-x here, not on the page or AppShell: a table whose
          content is genuinely too wide for a narrow viewport (e.g. a long
          campaign name at 390px) should scroll locally, not force the whole
          page wider than the screen -- the exact defect E7's real mobile
          screenshot caught (AppShell.tsx's `minWidth: 0` is the other half
          of this fix, letting this container actually shrink enough for
          this rule to matter). */}
      <div style={{ overflowX: "auto", marginTop: tokens.space[3] }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", lineHeight: "var(--lh-table)" }}>{t("campaign.name")}</th>
              <th style={{ textAlign: "left", lineHeight: "var(--lh-table)" }}>{t("campaign.lifecycle")}</th>
            </tr>
          </thead>
          <tbody>
            {board.campaigns.map((campaign) => (
              <tr key={campaign.id} style={{ borderTop: "1px solid var(--color-rule)" }}>
                <td style={{ lineHeight: "var(--lh-table)" }}>
                  <a href={`/campaigns/${campaign.id}`} style={{ color: "var(--color-cham)" }}>
                    {campaign.name}
                  </a>
                </td>
                <td style={{ lineHeight: "var(--lh-table)" }}>
                  <StateRibbon state={campaign.state} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
