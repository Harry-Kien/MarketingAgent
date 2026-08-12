import { requireWorkspace } from "../../../server/auth.ts";
import { UnauthorizedError } from "../../../server/session.ts";
import { PageState } from "../../../ui/PageState.tsx";
import { t } from "../../../i18n/index.ts";

/**
 * Analytics ("Kết quả"). `MetricValue` (apps/web/src/ui/MetricValue.tsx)
 * is the piece of this task that actually enforces "freshness bắt buộc":
 * it structurally refuses to render a number without a known as-of time,
 * attribution model/window and confidence tier, and visibly flags a metric
 * older than 24h as stale rather than letting it pass for current.
 *
 * This page does not call it with any metric yet. There is no
 * metrics/analytics table anywhere in `infra/migrations/**` -- P3 is
 * explicitly forbidden from adding one (another track owns the migration
 * sequence) -- so there is no real number this page could show today. The
 * honest rendering for "no data source exists yet" is `PageState
 * kind="empty"` with a detail that says exactly that, not a fabricated
 * metric object standing in for real data, and not silently omitting the
 * page. Once a real metrics source lands, this page wires it through
 * `MetricValue` the same way every other page in this track wires a real
 * query through its own presentational component.
 */
export default async function AnalyticsPage() {
  try {
    await requireWorkspace();
  } catch (error) {
    if (error instanceof UnauthorizedError) return <PageState kind="unauthorized" />;
    throw error;
  }

  return <PageState kind="empty" detail={t("analytics.noDataSource")} />;
}
