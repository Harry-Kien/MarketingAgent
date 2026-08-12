import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { PAGE_STATE_KINDS, PageState } from "./PageState.tsx";

// @testing-library/react, jest-dom and user-event are not installed (see
// StateRibbon.test.tsx for why: avoiding a new shared-lockfile dependency).
// Non-interactive assertions render to a static HTML string via
// react-dom/server (already a dependency). The one interactive assertion
// (retry button calls onRetry) is checked by calling PageState as a plain
// function -- it uses no hooks, so this legally returns its React element
// tree -- and walking that tree to find the <button>, rather than
// simulating a browser click event, which needs jsdom.
function findButton(el: unknown): ReactElement<{ onClick?: () => void }> | null {
  if (el === null || typeof el !== "object") return null;
  const node = el as { type?: unknown; props?: { children?: unknown } };
  if (node.type === "button") return el as ReactElement<{ onClick?: () => void }>;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findButton(child);
    if (found !== null) return found;
  }
  return null;
}

describe("PageState", () => {
  it("covers all seven required states", () => {
    expect(PAGE_STATE_KINDS).toHaveLength(7);
    expect(new Set(PAGE_STATE_KINDS).size).toBe(7);
  });

  it.each(PAGE_STATE_KINDS)("%s renders visible Vietnamese text inside a status region", (kind) => {
    const html = renderToStaticMarkup(<PageState kind={kind} />);
    expect(html).toContain('role="status"');
    // Every state string in vi.ts is non-Latin-only Vietnamese; a raw ASCII
    // regex check would pass even for a blank label, so require at least one
    // visible (non-whitespace) character actually landed in the markup.
    const text = html.replace(/<[^>]+>/g, "").trim();
    expect(text.length).toBeGreaterThan(0);
  });

  it("renders a distinct message per state (no generic empty box)", () => {
    const texts = PAGE_STATE_KINDS.map((kind) =>
      renderToStaticMarkup(<PageState kind={kind} />).replace(/<[^>]+>/g, "").trim(),
    );
    expect(new Set(texts).size).toBe(PAGE_STATE_KINDS.length);
  });

  it("wires the retry button only where retrying makes sense", () => {
    const onRetry = vi.fn();
    const errorButton = findButton(PageState({ kind: "error", onRetry }));
    expect(errorButton).not.toBeNull();
    errorButton?.props.onClick?.();
    expect(onRetry).toHaveBeenCalledOnce();

    const unauthorizedButton = findButton(PageState({ kind: "unauthorized", onRetry }));
    expect(unauthorizedButton).toBeNull();
  });

  it("does not render a retry affordance when no onRetry is supplied, even for a retryable kind", () => {
    expect(findButton(PageState({ kind: "error" }))).toBeNull();
  });

  it("announces politely rather than assertively for non-errors", () => {
    const loadingHtml = renderToStaticMarkup(<PageState kind="loading" />);
    expect(loadingHtml).toContain('aria-live="polite"');
    const errorHtml = renderToStaticMarkup(<PageState kind="error" />);
    expect(errorHtml).toContain('aria-live="assertive"');
  });
});
