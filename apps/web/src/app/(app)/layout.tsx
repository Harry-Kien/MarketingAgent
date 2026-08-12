import type { ReactNode } from "react";
import { AppShell } from "../../ui/AppShell.tsx";
import { PageState } from "../../ui/PageState.tsx";
import { requireWorkspace } from "../../server/auth.ts";
import { UnauthorizedError } from "../../server/session.ts";
import { getPool } from "../../server/db.ts";
import { getTodayBoard } from "../../server/queries.ts";

/**
 * The real operating console (blueprint Task 7-9), replacing the P0
 * placeholder at `apps/web/src/app/layout.tsx`. Every route under this
 * group goes through `requireWorkspace()` once, here, rather than each page
 * remembering to call it -- so a page can never render its content without
 * a resolved server-side session (Global Constraint: "workspaceId không bao
 * giờ đến từ client"). `requireWorkspace()` is a documented stub that
 * always throws `UnauthorizedError` until a real session backend lands
 * (see `apps/web/src/server/auth.ts`); that is surfaced here as the
 * `unauthorized` PageState -- the correct, honest rendering for "no auth
 * backend yet" rather than faking a signed-in shell.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  let workspaceId;
  try {
    ({ workspaceId } = await requireWorkspace());
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return <PageState kind="unauthorized" />;
    }
    throw error;
  }

  // The badge is supplementary chrome, not the page's own content: if the
  // count query fails for any reason, the shell still renders (with 0) so
  // one flaky count query can't take down navigation for the whole app. The
  // page body underneath still runs its own query and shows its own
  // `error`/`empty`/etc. PageState independently.
  let pendingApprovals = 0;
  try {
    pendingApprovals = (await getTodayBoard(getPool(), workspaceId)).pendingApprovalCount;
  } catch {
    pendingApprovals = 0;
  }

  return <AppShell pendingApprovals={pendingApprovals}>{children}</AppShell>;
}
