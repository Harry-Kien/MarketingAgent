import { describe, expect, it } from "vitest";
import { findJsRelativeImports } from "./import-guard.mjs";

describe("findJsRelativeImports", () => {
  it("flags a relative import ending in .js", () => {
    expect(findJsRelativeImports(`import { a } from "./logger.js";`)).toEqual(["./logger.js"]);
  });

  it("flags a parent-relative import ending in .js", () => {
    expect(findJsRelativeImports(`import { a } from "../../lib/health.js";`)).toEqual([
      "../../lib/health.js",
    ]);
  });

  it("flags a dynamic import too", () => {
    expect(findJsRelativeImports(`const m = await import("./main.js");`)).toEqual(["./main.js"]);
  });

  it("allows the .ts form", () => {
    expect(findJsRelativeImports(`import { a } from "./logger.ts";`)).toEqual([]);
  });

  it("allows bare package specifiers that happen to contain .js", () => {
    expect(findJsRelativeImports(`import x from "some.js-package";`)).toEqual([]);
    expect(findJsRelativeImports(`import x from "@smos/telemetry";`)).toEqual([]);
  });
});
