import type { ReactNode } from "react";
import { AppShell } from "../../ui/AppShell.tsx";
import { PageState } from "../../ui/PageState.tsx";
import { requireWorkspace } from "../../server/auth.ts";
import { UnauthorizedError } from "../../server/session.ts";

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
 *
 * `pendingApprovals` is a placeholder 0 here; `(app)/page.tsx` (Task 8)
 * wires it to `getTodayBoard`'s real count once that query exists.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  try {
    await requireWorkspace();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return <PageState kind="unauthorized" />;
    }
    throw error;
  }
  return <AppShell pendingApprovals={0}>{children}</AppShell>;
}
