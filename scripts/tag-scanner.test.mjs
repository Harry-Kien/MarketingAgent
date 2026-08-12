import { describe, expect, it } from "vitest";
import { scanTags } from "./tag-scanner.mjs";

describe("scanTags", () => {
  it("does not truncate an open tag on a `>` inside a brace-expression attribute", () => {
    const src = `<Badge variant={score > threshold ? "good" : "bad"} placeholder="Nhập tên chiến dịch" />`;
    const tokens = scanTags(src);
    const open = tokens.find((t) => t.kind === "open");
    expect(open).toBeDefined();
    expect(open.attrs).toContain("placeholder=");
    expect(open.attrs).toContain(`"Nhập tên chiến dịch"`);
    expect(open.selfClosing).toBe(true);
  });

  it("skips a `>` inside a quoted attribute value", () => {
    const src = `<a title="5 > 3" href="/x">text</a>`;
    const tokens = scanTags(src);
    const open = tokens.find((t) => t.kind === "open");
    expect(open.attrs).toBe(`<a title="5 > 3" href="/x">`);
  });

  it("tracks nested open/close/text in document order", () => {
    const src = `<div className="font-display"><span>a</span></div>`;
    const kinds = scanTags(src).map((t) => t.kind);
    expect(kinds).toEqual(["open", "open", "text", "close", "close"]);
  });

  it("marks self-closing tags and does not emit a matching close", () => {
    const src = `<img src="x" />`;
    const tokens = scanTags(src);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].selfClosing).toBe(true);
  });
});
