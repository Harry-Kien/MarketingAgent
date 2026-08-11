import { describe, expect, it } from "vitest";
import { findTenancyViolations, findRlsViolations, GLOBAL_TABLES } from "./migration-guards.mjs";

describe("findTenancyViolations", () => {
  it("flags a workspace-owned table without workspace_id", () => {
    const sql = `CREATE TABLE campaign (id uuid PRIMARY KEY, name text NOT NULL);`;
    expect(findTenancyViolations(sql)).toEqual(["campaign"]);
  });

  it("accepts a table that has workspace_id", () => {
    const sql = `CREATE TABLE campaign (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspace(id), name text NOT NULL);`;
    expect(findTenancyViolations(sql)).toEqual([]);
  });

  it("exempts declared global tables", () => {
    const sql = `CREATE TABLE workspace (id uuid PRIMARY KEY, name text NOT NULL);`;
    expect(GLOBAL_TABLES).toContain("workspace");
    expect(findTenancyViolations(sql)).toEqual([]);
  });
});

describe("findRlsViolations", () => {
  it("flags a workspace-owned table with no ENABLE ROW LEVEL SECURITY", () => {
    const sql = `CREATE TABLE campaign (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);`;
    expect(findRlsViolations(sql)).toEqual(["campaign"]);
  });

  it("accepts a table that enables RLS", () => {
    const sql = `
      CREATE TABLE campaign (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
      ALTER TABLE campaign ENABLE ROW LEVEL SECURITY;`;
    expect(findRlsViolations(sql)).toEqual([]);
  });
});

describe("regression: comment stripping and schema qualification", () => {
  it("flags a table with commented-out workspace_id as tenancy violation", () => {
    const sql = `CREATE TABLE campaign (
      id uuid PRIMARY KEY,
      -- workspace_id uuid NOT NULL REFERENCES workspace(id),
      name text NOT NULL
    );`;
    expect(findTenancyViolations(sql)).toEqual(["campaign"]);
  });

  it("flags a table with commented-out ENABLE ROW LEVEL SECURITY as RLS violation", () => {
    const sql = `CREATE TABLE campaign (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
      -- ALTER TABLE campaign ENABLE ROW LEVEL SECURITY;`;
    expect(findRlsViolations(sql)).toEqual(["campaign"]);
  });

  it("flags schema-qualified table without workspace_id as tenancy violation", () => {
    const sql = `CREATE TABLE public.campaign (id uuid PRIMARY KEY, name text NOT NULL);`;
    expect(findTenancyViolations(sql)).toEqual(["campaign"]);
  });

  it("flags schema-qualified table without RLS as RLS violation", () => {
    const sql = `CREATE TABLE public.campaign (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);`;
    expect(findRlsViolations(sql)).toEqual(["campaign"]);
  });

  it("exempts schema-qualified global tables from tenancy check", () => {
    const sql = `CREATE TABLE public.workspace (id uuid PRIMARY KEY, name text NOT NULL);`;
    expect(findTenancyViolations(sql)).toEqual([]);
  });

  it("flags table with block-comment-hidden workspace_id as tenancy violation", () => {
    const sql = `CREATE TABLE campaign (
      id uuid PRIMARY KEY,
      /* workspace_id uuid NOT NULL REFERENCES workspace(id), */
      name text NOT NULL
    );`;
    expect(findTenancyViolations(sql)).toEqual(["campaign"]);
  });
});
