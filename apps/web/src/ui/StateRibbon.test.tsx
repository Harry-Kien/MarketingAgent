import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// StateRibbon.tsx is a .tsx source file. Unlike tsc (which accepts a ".ts"
// specifier for a ".tsx" file under moduleResolution "bundler" +
// allowImportingTsExtensions), the oxc/vite resolver vitest uses does not
// substitute extensions once one is given explicitly, so the specifier here
// has to match the real file extension.
import { StateRibbon } from "./StateRibbon.tsx";

// @testing-library/react, @testing-library/jest-dom and jsdom are not
// installed in this workspace and the brief asks to avoid new npm
// dependencies (shared lockfile, three agents working concurrently). Since
// StateRibbon is a pure, non-interactive server-renderable component, the
// same assertions the plan's testing-library version makes (role counts,
// data-* attributes, accessible label) are made here directly against the
// static-markup HTML string using react-dom/server, which is already a
// dependency of @smos/web. No jsdom/DOM APIs are needed because nothing in
// this component is ever clicked or otherwise interacted with.
function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("StateRibbon", () => {
  it("renders eleven stops", () => {
    const html = renderToStaticMarkup(<StateRibbon state="DRAFT" />);
    expect(count(html, 'role="presentation"')).toBe(11);
  });

  it("marks stops before the current one as done", () => {
    const html = renderToStaticMarkup(<StateRibbon state="WAITING_APPROVAL" />);
    expect(count(html, 'data-stop="done"')).toBe(5);
    expect(count(html, 'data-stop="now"')).toBe(1);
  });

  it("uses the tho accent only while waiting on the founder", () => {
    const waiting = renderToStaticMarkup(<StateRibbon state="WAITING_APPROVAL" />);
    const running = renderToStaticMarkup(<StateRibbon state="EXECUTING" />);
    expect(waiting).toContain('data-accent="tho"');
    expect(waiting).not.toContain('data-accent="ink"');
    expect(running).toContain('data-accent="ink"');
    expect(running).not.toContain('data-accent="tho"');
  });

  it("shows a broken ribbon for a failed state", () => {
    const html = renderToStaticMarkup(<StateRibbon state="FAILED_TERMINAL" />);
    expect(html).toContain('data-broken="true"');
  });

  it("does not mark a healthy, in-flight state as broken", () => {
    const html = renderToStaticMarkup(<StateRibbon state="EXECUTING" />);
    expect(html).not.toContain("data-broken");
  });

  it("exposes an accessible label instead of relying on colour alone", () => {
    const html = renderToStaticMarkup(<StateRibbon state="WAITING_APPROVAL" />);
    expect(html).toContain('aria-label="Chờ duyệt"');
  });
});
