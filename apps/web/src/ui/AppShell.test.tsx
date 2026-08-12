import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// AppShell.tsx is a .tsx source file; the oxc/vite resolver vitest uses does
// not substitute extensions once one is given explicitly (see
// StateRibbon.test.tsx for the same note), so the specifier matches the real
// file extension rather than the repo's usual relative-import-ends-in-`.ts`
// convention.
import { AppShell } from "./AppShell.tsx";

// @testing-library/react and jsdom are not installed in this workspace (see
// StateRibbon.test.tsx / PageState.test.tsx for why -- avoiding a new
// shared-lockfile dependency). AppShell renders no hooks and needs no click
// simulation for these assertions, so the same static-markup-plus-string-scan
// approach is used here.
describe("AppShell", () => {
  it("renders the five navigation destinations, each as a real link", () => {
    const html = renderToStaticMarkup(
      <AppShell pendingApprovals={0}>
        <div />
      </AppShell>,
    );
    const destinations: Array<[string, string]> = [
      ["/", "Sổ điều hành"],
      ["/campaigns", "Chiến dịch"],
      ["/content", "Nội dung"],
      ["/approvals", "Phê duyệt"],
      ["/analytics", "Kết quả"],
    ];
    for (const [href, label] of destinations) {
      const escapedHref = href.replace(/\//g, "\\/");
      const pattern = new RegExp(`<a[^>]*href="${escapedHref}"[^>]*>([\\s\\S]*?)<\\/a>`);
      const match = pattern.exec(html);
      expect(match, `expected a link to ${href}`).not.toBeNull();
      expect(match?.[1]).toContain(label);
    }
  });

  it("shows the approval badge only when something is pending", () => {
    const withoutPending = renderToStaticMarkup(
      <AppShell pendingApprovals={0}>
        <div />
      </AppShell>,
    );
    expect(withoutPending).not.toContain('data-testid="approval-badge"');

    const withPending = renderToStaticMarkup(
      <AppShell pendingApprovals={3}>
        <div />
      </AppShell>,
    );
    expect(withPending).toContain('data-testid="approval-badge"');
    const badgeMatch = /<[^>]*data-testid="approval-badge"[^>]*>([^<]*)</.exec(withPending);
    expect(badgeMatch?.[1]).toContain("3");
  });

  it("does not show a negative or zero count as a pending badge", () => {
    // Adversarial: a caller passing a negative count (a bug elsewhere) must
    // not render a badge that reads as "pending" when nothing is.
    const html = renderToStaticMarkup(
      <AppShell pendingApprovals={-1}>
        <div />
      </AppShell>,
    );
    expect(html).not.toContain('data-testid="approval-badge"');
  });

  it("has no persistent chat surface anywhere in the shell", () => {
    const html = renderToStaticMarkup(
      <AppShell pendingApprovals={0}>
        <div>content</div>
      </AppShell>,
    );
    expect(html).not.toContain('data-testid="chat-panel"');
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain('role="textbox"');
    // Strongest form of the check: the word never appears at all, in any
    // language, anywhere in the rendered shell -- not just absent as a
    // specific known widget.
    expect(html.toLowerCase()).not.toContain("chat");
  });

  it("exposes a command bar button, focusable by keyboard, naming its ⌘K shortcut", () => {
    const html = renderToStaticMarkup(
      <AppShell pendingApprovals={0}>
        <div />
      </AppShell>,
    );
    const buttonMatch = /<button\b([^>]*)>([\s\S]*?)<\/button>/.exec(html);
    expect(buttonMatch).not.toBeNull();
    const [, attrs = "", inner = ""] = buttonMatch ?? [];
    // Reachable by keyboard: no disabled attribute, no explicit tabindex="-1".
    expect(attrs).not.toContain("disabled");
    expect(attrs).not.toContain('tabindex="-1"');
    const accessibleText = attrs + inner;
    expect(accessibleText).toMatch(/⌘K|Ctrl\+K/);
  });

  it("marks the main region and the navigation as landmarks", () => {
    const html = renderToStaticMarkup(
      <AppShell pendingApprovals={0}>
        <div>unique-child-marker</div>
      </AppShell>,
    );
    expect(html).toMatch(/<main[^>]*>[\s\S]*unique-child-marker[\s\S]*<\/main>/);
    expect(html).toContain("<nav");
  });

  it("does not define a /chat route anywhere in the app tree", () => {
    // Structural guard against the design thesis regressing: a real
    // filesystem check, not just a markup scan of one component -- a /chat
    // route could exist and simply not be linked from AppShell's nav.
    expect(existsSync("apps/web/src/app/chat")).toBe(false);
    expect(existsSync("apps/web/src/app/(app)/chat")).toBe(false);
  });
});
