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

  // ---------------------------------------------------------------------------
  // Fix round 3: a TSX generic component instantiation -- `<Select<string> />`
  // -- was not recognised at all. The name-match regex stops at the second
  // `<` (it isn't a name character), so the depth-tracking loop that looks
  // for the tag's real closing `>` started scanning from inside the generic
  // argument list itself, found the FIRST `>` (closing the generic, not the
  // tag), and treated `<Select<string>` as a complete tag with everything
  // after it -- including every attribute -- left as unmatched trailing text.
  // ---------------------------------------------------------------------------
  it("carries a single-level generic argument list as part of the tag, not a truncation point", () => {
    const src = `<Select<string> placeholder="Nhập tên chiến dịch" />`;
    const tokens = scanTags(src);
    const open = tokens.find((t) => t.kind === "open");
    expect(open).toBeDefined();
    expect(open.attrs).toContain(`placeholder="Nhập tên chiến dịch"`);
    expect(open.selfClosing).toBe(true);
  });

  it("carries a nested generic argument list (<Foo<Bar<T>>>) as part of the tag", () => {
    const src = `<Foo<Bar<T>>> placeholder="Nhập tên chiến dịch" />`;
    const tokens = scanTags(src);
    const open = tokens.find((t) => t.kind === "open");
    expect(open).toBeDefined();
    expect(open.attrs).toContain(`placeholder="Nhập tên chiến dịch"`);
    expect(open.selfClosing).toBe(true);
  });
});
