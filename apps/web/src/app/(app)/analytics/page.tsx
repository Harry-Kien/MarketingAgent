import { requireWorkspace } from "../../../server/auth.ts";
import { UnauthorizedError } from "../../../server/session.ts";
import { getPool } from "../../../server/db.ts";
import { getLatestMetrics } from "../../../server/queries.ts";
import { MetricValue } from "../../../ui/MetricValue.tsx";
import { PageState } from "../../../ui/PageState.tsx";
import { t } from "../../../i18n/index.ts";

/**
 * Analytics ("Kết quả"). `MetricValue` (apps/web/src/ui/MetricValue.tsx)
 * is the piece of this page that actually enforces "freshness bắt buộc": it
 * structurally refuses to render a number without a known as-of time,
 * attribution model/window and confidence tier, and visibly flags a metric
 * older than 24h as stale rather than letting it pass for current.
 *
 * Late-review MINOR (e): this page used to state -- in a comment and in its
 * own empty-state copy -- that "there is no metrics/analytics table anywhere
 * in infra/migrations/**". That stopped being true at
 * 0028_integration.sql, which created `metric`, and the webhook route has
 * been writing to it on every verified delivery since. Real numbers were
 * accumulating in the database while this page told the founder no data
 * source existed: a fabricated ABSENCE, which is the same honesty failure as
 * a fabricated success, pointed the other way. It reads the real table now.
 *
 * The empty state is still reachable and still honest -- it now says the
 * true thing ("no metrics recorded yet for this workspace") instead of
 * claiming the capability does not exist at all.
 */
export default async function AnalyticsPage() {
  let workspaceId;
  try {
    ({ workspaceId } = await requireWorkspace());
  } catch (error) {
    if (error instanceof UnauthorizedError) return <PageState kind="unauthorized" />;
    throw error;
  }

  const metrics = await getLatestMetrics(getPool(), workspaceId);
  if (metrics.length === 0) {
    return <PageState kind="empty" detail={t("analytics.noMetricsYet")} />;
  }

  return (
    <section>
      <h1>{t("analytics.title")}</h1>
      {metrics.map((metric) => (
        <article key={`${metric.campaignId}:${metric.name}`}>
          <h2>
            {metric.campaignName} — {metric.name}
          </h2>
          <MetricValue
            metric={{
              value: metric.value,
              // `metric.unit` is nullable in the schema and MetricValue
              // treats a missing unit as "this number cannot be shown
              // honestly" rather than inventing one. What the webhook ingest
              // records is a count of events, so that is what an absent unit
              // means here -- stated, not guessed.
              unit: metric.unit ?? "lần",
              freshnessAt: metric.freshnessAt,
              attributionModel: metric.attributionModel,
              attributionWindow: metric.attributionWindow,
              confidence: metric.confidence,
              missingDataNote: metric.missingDataNote,
            }}
          />
        </article>
      ))}
    </section>
  );
}
