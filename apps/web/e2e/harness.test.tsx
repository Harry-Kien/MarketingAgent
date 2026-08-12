import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildHarnessDocument } from "./harness.tsx";

const outputPath = (name: string) => fileURLToPath(new URL(`./.generated/${name}`, import.meta.url));

// This is not the plan's literal E11 test (Playwright + @axe-core/playwright
// are absent from this workspace and installing them is forbidden -- a new
// dependency in a shared lockfile). It is the deterministic, versioned half
// of the E11 evidence: it proves the harness document actually contains the
// real production components' markup, in the order a keyboard user would
// reach them, and writes the file a Playwright MCP browser session drives
// interactively (see apps/web/e2e/harness.tsx's own header, and the
// Tasks 10-11 report for that session's transcript).
function order(html: string, needles: string[]): number[] {
  return needles.map((n) => html.indexOf(n));
}

describe("keyboard/a11y harness", () => {
  it("includes all five real nav destinations, the command bar, and the approval controls, in document order", () => {
    const html = buildHarnessDocument("light");
    const positions = order(html, [
      'aria-label="Điều hướng chính"', // AppShell's nav landmark
      "Sổ điều hành", // nav.today
      "Chiến dịch", // nav.campaigns
      "Nội dung", // nav.content
      "Phê duyệt", // nav.approvals
      "Kết quả", // nav.analytics
      "Mở thanh lệnh (⌘K)", // command bar button
      'name="reason"', // approval textarea
      'value="approve"',
      'value="reject"',
      'value="request_changes"',
    ]);
    for (const p of positions) expect(p).toBeGreaterThan(-1);
    for (let i = 1; i < positions.length; i++) expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
  });

  it("includes a real, focusable retry affordance from PageState", () => {
    const html = buildHarnessDocument("light");
    expect(html).toContain("<button");
    expect(html).toContain("Thử lại");
  });

  it("marks StateRibbon's decorative stops as aria-hidden so they add no false tab stops", () => {
    const html = buildHarnessDocument("light");
    expect(html).toContain('aria-hidden="true"');
  });

  it("inlines the real generated tokens.css rather than a hand-copied subset", () => {
    const html = buildHarnessDocument("light");
    expect(html).toContain("--color-paper: #FBFBFA");
    expect(html).toContain('[data-theme="dark"]');
  });

  it("sets data-theme so the dark variant actually activates tokens.css's dark block", () => {
    const light = buildHarnessDocument("light");
    const dark = buildHarnessDocument("dark");
    expect(light).toContain('data-theme="light"');
    expect(dark).toContain('data-theme="dark"');
  });

  it("writes both theme variants to disk for the Playwright MCP session to open", () => {
    const lightPath = outputPath("keyboard-harness-light.html");
    const darkPath = outputPath("keyboard-harness-dark.html");
    mkdirSync(fileURLToPath(new URL("./.generated/", import.meta.url)), { recursive: true });
    writeFileSync(lightPath, buildHarnessDocument("light"));
    writeFileSync(darkPath, buildHarnessDocument("dark"));
    expect(existsSync(lightPath)).toBe(true);
    expect(existsSync(darkPath)).toBe(true);
  });
});
