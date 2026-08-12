import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// @testing-library/react and jsdom are not installed in this workspace (see
// StateRibbon.test.tsx / PageState.test.tsx for the established reasoning:
// avoiding a new shared-lockfile dependency). MetricValue is server-
// renderable and has no interactive DOM behaviour of its own (its only
// affordance, `PageState`'s retry button, is not wired up here since a
// metric has nothing to retry), so plain `renderToStaticMarkup` plus string
// assertions on the markup is enough, matching the rest of this track.
import { MetricValue, STALE_THRESHOLD_MS, type Metric } from "./MetricValue.tsx";

const full: Metric = {
  value: 12.5,
  unit: "%",
  freshnessAt: new Date("2026-08-11T00:00:00.000Z"),
  attributionModel: "last_touch",
  attributionWindow: "7d",
  confidence: "medium",
  missingDataNote: null,
};

// A fixed "now" 12h after freshnessAt: within the staleness threshold.
const FRESH_NOW = new Date(full.freshnessAt.getTime() + 12 * 60 * 60 * 1000);
// A fixed "now" 48h after freshnessAt: past the staleness threshold.
const STALE_NOW = new Date(full.freshnessAt.getTime() + 48 * 60 * 60 * 1000);

describe("MetricValue", () => {
  it("renders the number when every required field is present", () => {
    const html = renderToStaticMarkup(<MetricValue metric={full} now={FRESH_NOW} />);
    expect(html).toMatch(/12,5|12\.5/);
  });

  it.each(["freshnessAt", "attributionModel", "confidence"] as const)(
    "refuses to render a number when %s is missing",
    (field) => {
      const broken = { ...full, [field]: null } as unknown as Metric;
      const html = renderToStaticMarkup(<MetricValue metric={broken} now={FRESH_NOW} />);
      expect(html).not.toMatch(/12,5|12\.5/);
      expect(html).toContain('role="status"');
    },
  );

  it("always shows the attribution model next to the number", () => {
    const html = renderToStaticMarkup(<MetricValue metric={full} now={FRESH_NOW} />);
    expect(html).toMatch(/last_touch/);
  });

  it("surfaces a missing-data note when present", () => {
    const html = renderToStaticMarkup(
      <MetricValue metric={{ ...full, missingDataNote: "thiếu 2 ngày" }} now={FRESH_NOW} />,
    );
    expect(html).toContain("thiếu 2 ngày");
  });

  // --- Hardening beyond the plan's literal three-field table: a metric with
  // no value, no unit, or no stated attribution window is exactly as
  // unrenderable as one with no freshness or confidence -- rendering "%" with
  // no number, or a number with no unit, is not honest either.
  it.each(["value", "unit", "attributionWindow"] as const)(
    "refuses to render a number when %s is missing (hardening beyond the plan's table)",
    (field) => {
      const broken = { ...full, [field]: null } as unknown as Metric;
      const html = renderToStaticMarkup(<MetricValue metric={broken} now={FRESH_NOW} />);
      expect(html).not.toMatch(/12,5|12\.5/);
      expect(html).toContain('role="status"');
    },
  );

  it("refuses to render a number when the metric itself is null", () => {
    const html = renderToStaticMarkup(<MetricValue metric={null} now={FRESH_NOW} />);
    expect(html).not.toMatch(/12,5|12\.5/);
    expect(html).toContain('role="status"');
  });

  it("says explicitly that freshness is unknown, not just 'data incomplete', when freshnessAt is missing", () => {
    const broken = { ...full, freshnessAt: null } as unknown as Metric;
    const html = renderToStaticMarkup(<MetricValue metric={broken} now={FRESH_NOW} />);
    // The generic PageState "partial" copy alone would satisfy the given
    // test but not the brief's truthfulness requirement ("if freshness is
    // unknown the UI must say so rather than omitting the question") --
    // assert the freshness-specific detail text is present, not just any
    // status role.
    expect(html).toContain("Không rõ thời điểm cập nhật");
  });

  // --- Freshness must always be visible on a rendered metric, and staleness
  // must never be silently absorbed into "current".
  it("always shows the as-of freshness time next to a rendered number", () => {
    const html = renderToStaticMarkup(<MetricValue metric={full} now={FRESH_NOW} />);
    expect(html).toContain(full.freshnessAt.toISOString());
  });

  it("does not show a stale marker when freshnessAt is within the 24h threshold", () => {
    const html = renderToStaticMarkup(<MetricValue metric={full} now={FRESH_NOW} />);
    expect(html).not.toContain("Dữ liệu đã cũ");
  });

  it("shows a visible stale marker when freshnessAt is older than the 24h threshold", () => {
    const html = renderToStaticMarkup(<MetricValue metric={full} now={STALE_NOW} />);
    expect(html).toMatch(/12,5|12\.5/); // still renders the number: freshness IS known, just old
    expect(html).toContain("Dữ liệu đã cũ");
    expect(html).toContain('role="status"');
  });

  it("treats exactly the threshold boundary as not yet stale", () => {
    const boundaryNow = new Date(full.freshnessAt.getTime() + STALE_THRESHOLD_MS);
    const html = renderToStaticMarkup(<MetricValue metric={full} now={boundaryNow} />);
    expect(html).not.toContain("Dữ liệu đã cũ");
  });

  it("treats one millisecond past the threshold as stale", () => {
    const justPast = new Date(full.freshnessAt.getTime() + STALE_THRESHOLD_MS + 1);
    const html = renderToStaticMarkup(<MetricValue metric={full} now={justPast} />);
    expect(html).toContain("Dữ liệu đã cũ");
  });
});
