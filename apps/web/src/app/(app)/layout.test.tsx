import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AppLayout from "./layout.tsx";

// requireWorkspace() (apps/web/src/server/auth.ts) is a documented stub that
// always throws UnauthorizedError until a real session backend is wired up
// (Task 4's report). That is the one adversarial state this layout can
// actually be exercised against today without faking a session: every
// request into the (app) route group must render the `unauthorized`
// PageState rather than silently rendering AppShell/children with no
// resolved workspace.
describe("AppLayout", () => {
  it("renders the unauthorized PageState instead of the shell when no session is resolvable", async () => {
    const element = await AppLayout({ children: <div>secret content</div> });
    const html = renderToStaticMarkup(element);
    expect(html).toContain('role="status"');
    expect(html).not.toContain("secret content");
    expect(html).not.toContain("<nav");
  });
});
