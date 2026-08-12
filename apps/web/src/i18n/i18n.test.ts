import { describe, expect, it } from "vitest";
import { t } from "./index.ts";

describe("t", () => {
  it("resolves a nested key", () => { expect(t("approval.pendingTitle")).toBe("Đang chờ bạn phê duyệt"); });
  it("interpolates variables", () => { expect(t("approval.pendingCount", { count: 3 })).toContain("3"); });
  it("throws on an unknown key so a missing string never ships as blank", () => {
    expect(() => t("nope.missing" as never)).toThrow(/unknown message key/i);
  });
  it("leaves an unmatched placeholder visible rather than silently empty", () => {
    expect(t("approval.pendingCount", {})).toContain("{count}");
  });
});
