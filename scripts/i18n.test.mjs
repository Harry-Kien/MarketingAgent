import { describe, expect, it } from "vitest";
import { findHardcodedVietnamese } from "./i18n-guard.mjs";
import { FALSE_POSITIVE_FIXTURE } from "./false-positive-fixture.mjs";

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
    // Fix round 2: this case used to be `data-tooltip` (a data-* attribute).
    // The reviewer established that data-* is categorically non-user-visible
    // (test hooks and custom data, not display copy) and must NOT be
    // flagged -- see the legitimate table below. Renamed to `label`, a
    // realistic custom-component prop that DOES render text and was never
    // on the original four-name whitelist either, so this case still proves
    // what it always proved: generalizing beyond a fixed attribute list
    // catches attributes the list never named, just not data-* ones.
    ["attribute not on any fixed whitelist, and genuinely user-visible (label)", `<button label="Huỷ chiến dịch">X</button>`],
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
    // Fix round 2: attributes that never render text to a human.
    ["data-testid with a Vietnamese value (test hook, not display copy)", `<div data-testid="đã-đăng-card" />`],
    ["data-cy with a Vietnamese value (test hook, not display copy)", `<button data-cy="nút-huỷ" />`],
    ["id/className/key/type/role/href with Vietnamese-looking values (structural, not display copy)",
      `<a id="mo-ta" className="thẻ-lỗi" role="điều-hướng" type="button" href="/chiến-dịch">x</a>`],
  ];
  for (const [name, src] of cases) {
    it(`allows: ${name}`, () => {
      expect(findHardcodedVietnamese(src), src).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Fix round 2: round 1 traded false negatives for false positives (data-*
// swept in by the attribute generalization) and left one reachable gap open
// (the OPEN_TAG regex truncates on a `>` inside a brace-expression prop).
// ---------------------------------------------------------------------------

describe("findHardcodedVietnamese -- attribute visibility is deliberate, not accidental (fix round 2)", () => {
  it("still flags aria-label with a Vietnamese value", () => {
    expect(findHardcodedVietnamese(`<button aria-label="Huỷ chiến dịch" />`).length).toBeGreaterThan(0);
  });
  it("still flags alt with a Vietnamese value", () => {
    expect(findHardcodedVietnamese(`<img alt="Ảnh đại diện" />`).length).toBeGreaterThan(0);
  });
  it("still flags title with a Vietnamese value", () => {
    expect(findHardcodedVietnamese(`<span title="Đã đăng"></span>`).length).toBeGreaterThan(0);
  });
  it("does not flag aria-hidden/aria-describedby/aria-controls even when their IDREF value uses diacritics (IDREF/boolean ARIA attrs, not rendered text)", () => {
    const src = `<div aria-hidden="đúng" aria-describedby="mô-tả-lỗi" aria-controls="bảng-chiến-dịch">x</div>`;
    expect(findHardcodedVietnamese(src)).toEqual([]);
  });
});

describe("findHardcodedVietnamese -- tag scan is not truncated by `>` inside an expression prop (fix round 2)", () => {
  it("still catches a hard-coded placeholder after a ternary containing `>`", () => {
    const src = `<Badge variant={score > threshold ? "good" : "bad"} placeholder="Nhập tên chiến dịch" />`;
    expect(findHardcodedVietnamese(src).length).toBeGreaterThan(0);
  });
  it("still catches a hard-coded placeholder after a `>` comparison inside a nested expression prop", () => {
    const src = `<Badge variant={items.filter(i => i.count > 0).length > 0 ? "good" : "bad"} placeholder="Nhập tên chiến dịch" />`;
    expect(findHardcodedVietnamese(src).length).toBeGreaterThan(0);
  });
});

describe("findHardcodedVietnamese -- text between two interpolations (self-discovered, fix round 2)", () => {
  it("flags hard-coded text sitting between two consecutive interpolations", () => {
    const src = `<h1>{t("nav.today")} và {t("nav.campaigns")}</h1>`;
    expect(findHardcodedVietnamese(src).length).toBeGreaterThan(0);
  });
  it("does not flag an ascii/punctuation separator between two interpolations", () => {
    const src = `<h1>{t("nav.today")} — {t("nav.campaigns")}</h1>`;
    expect(findHardcodedVietnamese(src)).toEqual([]);
  });
});

describe("findHardcodedVietnamese -- comments document the rule, they are not the violation (fix round 2)", () => {
  it("does not flag Vietnamese text inside a JSX comment", () => {
    expect(findHardcodedVietnamese(`<div>{/* ví dụ: "Sổ điều hành" */}</div>`)).toEqual([]);
  });
  it("still flags real rendered text next to a comment about it", () => {
    const src = `<div>{/* ví dụ */}<h1>Sổ điều hành</h1></div>`;
    expect(findHardcodedVietnamese(src).length).toBeGreaterThan(0);
  });
});

describe("permanent false-positive regression suite (fix round 2)", () => {
  it("findHardcodedVietnamese reports zero findings against ordinary component code", () => {
    expect(findHardcodedVietnamese(FALSE_POSITIVE_FIXTURE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fix round 3: a `//` inside an ordinary string value (not just after a URL
// scheme's `:`) blanked the rest of the line -- swallowing every attribute
// after it, not just the string itself -- and a TSX generic component
// instantiation truncated the tag scan entirely, hiding every attribute.
// ---------------------------------------------------------------------------

describe("findHardcodedVietnamese -- // inside an ordinary string is not a comment (fix round 3)", () => {
  it("flags aria-label on an element that also carries an https:// href", () => {
    const src = `<a href="https://example.com" aria-label="Mở trang chiến dịch">x</a>`;
    expect(findHardcodedVietnamese(src).length).toBeGreaterThan(0);
  });
  it("still ignores a genuine // comment containing Vietnamese", () => {
    const src = "// bình luận chứa tiếng Việt\nexport function X() { return null; }";
    expect(findHardcodedVietnamese(src)).toEqual([]);
  });
});

describe("findHardcodedVietnamese -- TSX generic component tags are not truncated (fix round 3)", () => {
  it("flags a hard-coded placeholder on a single-level generic component", () => {
    const src = `<Select<string> placeholder="Nhập tên chiến dịch" />`;
    expect(findHardcodedVietnamese(src).length).toBeGreaterThan(0);
  });
  it("flags a hard-coded placeholder on a nested generic component", () => {
    const src = `<Foo<Bar<T>>> placeholder="Nhập tên chiến dịch" />`;
    expect(findHardcodedVietnamese(src).length).toBeGreaterThan(0);
  });
});
