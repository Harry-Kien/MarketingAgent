import { describe, expect, it } from "vitest";
import { findHardcodedVietnamese } from "./i18n-guard.mjs";

describe("findHardcodedVietnamese", () => {
  it("flags Vietnamese text sitting directly in JSX", () => {
    expect(findHardcodedVietnamese(`<h1>Sổ điều hành</h1>`)).toHaveLength(1);
  });
  it("allows text that goes through t()", () => {
    expect(findHardcodedVietnamese(`<h1>{t("home.title")}</h1>`)).toEqual([]);
  });
  it("allows plain ascii", () => {
    expect(findHardcodedVietnamese(`<h1>Dashboard</h1>`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1: the original suite locked this guard with three assertions,
// but only one shape (bare JSX text). These tables cover every evasion the
// reviewer found plus the legitimate forms that must keep passing, so
// gutting the guard breaks many tests, not one or three.
// ---------------------------------------------------------------------------

describe("findHardcodedVietnamese -- violation table (must all be flagged)", () => {
  const cases = [
    ["JSX text directly in a tag", `<h1>Sổ điều hành</h1>`],
    ["attribute string value (placeholder)", `<input placeholder="Nhập tên chiến dịch" />`],
    ["attribute not on any fixed whitelist (data-tooltip)", `<button data-tooltip="Huỷ chiến dịch">X</button>`],
    ["template literal as a bare JSX expression child", "<h1>{`Sổ điều hành`}</h1>"],
    ["template literal as an attribute expression", "<input placeholder={`Nhập tên`} />"],
    ["text after an interpolation, before the closing tag", `<h1>Chào {name}, đây là báo cáo của bạn</h1>`],
    ["text before an interpolation", `<h1>Chào {name}</h1>`],
  ];
  for (const [name, src] of cases) {
    it(`flags: ${name}`, () => {
      expect(findHardcodedVietnamese(src).length, src).toBeGreaterThan(0);
    });
  }
});

describe("findHardcodedVietnamese -- legitimate table (must never be flagged)", () => {
  const cases = [
    ["goes through t()", `<h1>{t("home.title")}</h1>`],
    ["plain ascii", `<h1>Dashboard</h1>`],
    ["attribute goes through t()", `<input placeholder={t("campaign.title")} />`],
    ["pure interpolation, no adjacent text", `<div>{count}</div>`],
    ["template literal used only as the t() key argument, not the child", "<h1>{t(`approval.pendingTitle`)}</h1>"],
    ["ascii attribute value", `<div data-testid="home-title">{t("home.title")}</div>`],
    ["non-JSX brace/generic syntax with no Vietnamese content", `const ok = a > b ? { x: 1 } : { y: 2 };`],
  ];
  for (const [name, src] of cases) {
    it(`allows: ${name}`, () => {
      expect(findHardcodedVietnamese(src), src).toEqual([]);
    });
  }
});
