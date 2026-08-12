import { t, type MessageKey } from "../i18n/index.ts";
import { PageState } from "./PageState.tsx";
import { tokens } from "./tokens.ts";

export type MetricConfidence = "high" | "medium" | "low";

export interface Metric {
  value: number;
  unit: string;
  freshnessAt: Date;
  attributionModel: string;
  attributionWindow: string;
  confidence: MetricConfidence;
  missingDataNote: string | null;
}

/**
 * "Freshness bắt buộc" (freshness mandatory) -- a metric older than this is
 * not wrong, but it is old enough that showing it without saying so would
 * invite a same-day decision on yesterday's numbers. The product's own
 * operating cadence is daily (the "Sổ điều hành" today board is reviewed
 * once a day), so one day is the threshold past which a number needs a
 * visible flag rather than silently passing for current.
 */
export const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

const CONFIDENCE_KEY: Record<MetricConfidence, MessageKey> = {
  high: "analytics.confidenceHigh",
  medium: "analytics.confidenceMedium",
  low: "analytics.confidenceLow",
};

/**
 * Every founder-facing number must carry, together, in one place: the value
 * itself, the exact moment it was true as of (freshness), the model and
 * window that produced it (attribution), and how confident the pipeline is
 * in it. Any of those missing means the number cannot honestly be shown --
 * this checks the four presence-critical fields (value, unit, freshnessAt,
 * confidence) plus both attribution fields, not just the three the plan's
 * own test table names, because a value with no unit or an attribution
 * claim with no stated model/window is exactly as unverifiable as one with
 * no freshness.
 *
 * When freshness itself is unknown, the detail text says exactly that
 * ("khong ro thoi diem cap nhat") rather than only the generic "data
 * incomplete" copy -- the brief requires the UI to "say so rather than
 * omitting the question", and a generic incompleteness message doesn't
 * distinguish "we don't know how old this is" from "we're missing the
 * confidence tier".
 *
 * A metric that IS fresh enough to have a known age, but whose age exceeds
 * `STALE_THRESHOLD_MS`, still renders the number (freshness is known, only
 * old) but with a visible, `role="status"` stale marker next to it -- never
 * silently indistinguishable from a current number.
 */
export function MetricValue({ metric, now = new Date() }: { metric: Metric | null; now?: Date }) {
  const missingFreshness = metric === null || metric.freshnessAt == null;
  const incomplete =
    missingFreshness ||
    metric.value == null ||
    metric.unit == null ||
    metric.attributionModel == null ||
    metric.attributionWindow == null ||
    metric.confidence == null;

  if (incomplete) {
    return missingFreshness ? (
      <PageState kind="partial" detail={t("analytics.freshnessUnknown")} />
    ) : (
      <PageState kind="partial" />
    );
  }

  const stale = now.getTime() - metric.freshnessAt.getTime() > STALE_THRESHOLD_MS;
  const formattedValue = new Intl.NumberFormat("vi-VN").format(metric.value);
  const formattedFreshness = new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeStyle: "short" }).format(
    metric.freshnessAt,
  );

  return (
    <div style={{ lineHeight: "var(--lh-body)" }}>
      <p style={{ margin: 0 }}>
        <span className="font-display" style={{ lineHeight: "var(--lh-heading)" }}>
          {formattedValue}
          {metric.unit}
        </span>
      </p>
      <p style={{ margin: `${tokens.space[0]}px 0 0`, color: "var(--color-ink2)" }}>
        <time dateTime={metric.freshnessAt.toISOString()}>
          {t("analytics.freshness")}: {formattedFreshness}
        </time>
        {stale && (
          <span role="status" aria-live="polite" style={{ color: "var(--color-tho)", marginLeft: tokens.space[1] }}>
            {t("state.stale")}
          </span>
        )}
      </p>
      <p style={{ margin: `${tokens.space[0]}px 0 0`, color: "var(--color-ink2)" }}>
        {t("analytics.attributionModel")}: {metric.attributionModel}
        {" — "}
        {t("analytics.window")}: {metric.attributionWindow}
      </p>
      <p style={{ margin: `${tokens.space[0]}px 0 0`, color: "var(--color-ink2)" }}>
        {t("analytics.confidence")}: {t(CONFIDENCE_KEY[metric.confidence])}
      </p>
      {metric.missingDataNote !== null && (
        <p role="status" style={{ margin: `${tokens.space[0]}px 0 0`, color: "var(--color-tho)" }}>
          {metric.missingDataNote}
        </p>
      )}
    </div>
  );
}
