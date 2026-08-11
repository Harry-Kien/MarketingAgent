import { describe, expect, it } from "vitest";
import { findImpureImports } from "./domain-purity.mjs";

describe("findImpureImports", () => {
  it("flags drizzle, pg, next and react", () => {
    const src = `import { sql } from "drizzle-orm";\nimport pg from "pg";\nimport React from "react";`;
    expect(findImpureImports(src)).toEqual(["drizzle-orm", "pg", "react"]);
  });

  it("flags react-dom, pg-boss and @smos/db", () => {
    const src = `import { render } from "react-dom";\nimport PgBoss from "pg-boss";\nimport { schema } from "@smos/db";`;
    expect(findImpureImports(src)).toEqual(["react-dom", "pg-boss", "@smos/db"]);
  });

  it("flags next", () => {
    expect(findImpureImports(`import { redirect } from "next/navigation";`)).toEqual(["next/navigation"]);
  });

  it("allows node builtins and zod", () => {
    const src = `import { createHash } from "node:crypto";\nimport { z } from "zod";`;
    expect(findImpureImports(src)).toEqual([]);
  });

  it("allows sibling domain modules", () => {
    expect(findImpureImports(`import { newId } from "./ids.ts";`)).toEqual([]);
  });

  it("allows a parent-relative sibling import", () => {
    expect(findImpureImports(`import { Id } from "../ids.ts";`)).toEqual([]);
  });

  it("does not false-positive on an unrelated scoped package", () => {
    expect(findImpureImports(`import { logger } from "@smos/telemetry";`)).toEqual([]);
  });
});
