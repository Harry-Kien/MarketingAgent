import { requireWorkspace } from "../../../server/auth.ts";
import { UnauthorizedError } from "../../../server/session.ts";
import { getPool } from "../../../server/db.ts";
import { getPendingApprovals } from "../../../server/queries.ts";
import { PageState } from "../../../ui/PageState.tsx";
import { t } from "../../../i18n/index.ts";

/**
 * Approval Center: every approval request in the caller's workspace still
 * waiting on a decision -- `getPendingApprovals` runs inside `withTenant`,
 * scoped to the server-resolved workspace, exactly like every other query
 * in this app.
 */
export default async function ApprovalsPage() {
  let workspaceId;
  try {
    ({ workspaceId } = await requireWorkspace());
  } catch (error) {
    if (error instanceof UnauthorizedError) return <PageState kind="unauthorized" />;
    throw error;
  }

  let pending;
  try {
    pending = await getPendingApprovals(getPool(), workspaceId);
  } catch {
    return <PageState kind="error" />;
  }

  if (pending.length === 0) {
    return <PageState kind="empty" detail={t("approval.noPending")} />;
  }

  return (
    <div>
      <h1 className="font-display" style={{ lineHeight: "var(--lh-heading)", margin: 0 }}>
        {t("approval.pendingTitle")}
      </h1>
      <p>{t("approval.pendingCount", { count: pending.length })}</p>
      <ul>
        {pending.map((request) => (
          <li key={request.id} style={{ lineHeight: "var(--lh-body)" }}>
            <a href={`/approvals/${request.id}`} style={{ color: "var(--color-cham)" }}>
              {t("approval.targetChannel")}: {request.targetChannel}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
