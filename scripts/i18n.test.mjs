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
