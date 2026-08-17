import type { ReactNode } from "react";
import { t } from "../i18n/index.ts";
import { tokens } from "./tokens.ts";

interface NavDestination {
  href: string;
  label: () => string;
}

// Five destinations, no more. Global Constraint: "Không chat-first" -- this
// is the entire navigation surface, and none of the five is a message
// thread. Order matches the blueprint's own left-to-right priority: today's
// operating brief first, approvals near the end because it is reached via
// the badge as much as via this rail.
const DESTINATIONS: NavDestination[] = [
  { href: "/", label: () => t("nav.today") },
  { href: "/campaigns", label: () => t("nav.campaigns") },
  { href: "/content", label: () => t("nav.content") },
  { href: "/approvals", label: () => t("nav.approvals") },
  { href: "/analytics", label: () => t("nav.analytics") },
];

// The rail's width (224px) lives in globals.css alongside its media query,
// because the value and the breakpoint that retires it have to stay together.

/**
 * The operating console shell (blueprint: "AppShell"). A left rail plus a
 * command bar over structured page content -- deliberately not a chat
 * layout. There is no persistent input surface here at all: whatever a
 * founder does happens through the rail's five destinations, the command
 * bar, or the structured content each page renders (StateRibbon,
 * PageState, tables), never through a standing conversation with an agent.
 *
 * `pendingApprovals` is supplied by the caller (a server component that
 * already resolved the workspace via `requireWorkspace()`) rather than
 * fetched in here -- AppShell itself has no server/database dependency, so
 * it stays trivially testable and reusable if a future page needs to render
 * it without a live count yet.
 */
export function AppShell({
  pendingApprovals,
  children,
}: {
  pendingApprovals: number;
  children: ReactNode;
}) {
  return (
    <div className="app-shell" style={{ minHeight: "100vh", background: "var(--color-paper)" }}>
      {/* Layout lives in globals.css, not here, because the rail has to change
          axis below 720px and an inline style cannot express a media query.
          Above that it is a fixed-width left rail; below it becomes a
          horizontally scrollable strip along the top, so the five
          destinations stay the navigation surface at every size instead of
          the document growing wider than the viewport. E7's real-browser
          mobile run caught the fixed rail pushing the page past 390px. */}
      <nav
        className="app-rail"
        aria-label={t("shell.landmark")}
        style={{
          padding: tokens.space[3],
          gap: tokens.space[1],
        }}
      >
        {DESTINATIONS.map((dest) => {
          const label = dest.label();
          const showBadge = dest.href === "/approvals" && pendingApprovals > 0;
          return (
            <a
              key={dest.href}
              href={dest.href}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: `${tokens.space[1]}px ${tokens.space[2]}px`,
                color: "var(--color-ink)",
                lineHeight: "var(--lh-label)",
                textDecoration: "none",
              }}
            >
              <span>{label}</span>
              {showBadge && (
                <span
                  data-testid="approval-badge"
                  aria-label={t("approval.pendingCount", { count: pendingApprovals })}
                  style={{
                    color: "var(--color-tho)",
                    fontFamily: "var(--font-display)",
                    lineHeight: "var(--lh-label)",
                  }}
                >
                  {pendingApprovals}
                </span>
              )}
            </a>
          );
        })}
      </nav>
      {/* `minWidth: 0` overrides the flex default of `min-width: auto`, which
          otherwise refuses to let this column shrink below the intrinsic
          width of whatever it contains (a long campaign name in a table, for
          instance) -- the exact bug E7's real-browser mobile (390px)
          screenshot caught live: without this, the whole page grew wider
          than the viewport instead of the content wrapping/scrolling
          locally. See (app)/page.tsx's own `overflow-x: auto` wrapper around
          its table for the other half of this fix. */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <header
          style={{
            display: "flex",
            justifyContent: "flex-end",
            padding: tokens.space[2],
            borderBottom: "1px solid var(--color-rule)",
          }}
        >
          <button
            type="button"
            aria-label={t("shell.commandBarOpen")}
            style={{
              color: "var(--color-ink2)",
              background: "var(--color-surface)",
              border: "1px solid var(--color-rule)",
              borderRadius: "var(--radius-sm)",
              padding: `${tokens.space[0]}px ${tokens.space[1]}px`,
              lineHeight: "var(--lh-label)",
            }}
          >
            ⌘K
          </button>
        </header>
        <main style={{ flex: 1, padding: tokens.space[4] }}>{children}</main>
      </div>
    </div>
  );
}
