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

describe("regression: string literal and comment interaction", () => {
  it("does not swallow following table when /* appears in string literal", () => {
    const sql = `CREATE TABLE settings (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, value text DEFAULT 'weird /* value');
      /* real comment */
      CREATE TABLE campaign (id uuid PRIMARY KEY, name text NOT NULL);`;
    expect(findTenancyViolations(sql)).toEqual(["campaign"]);
  });

  it("does not hide statement when -- appears in string literal", () => {
    const sql = `CREATE TABLE campaign (id uuid PRIMARY KEY, name text DEFAULT 'see --docs', workspace_id uuid NOT NULL);`;
    // The regex stripper should not treat -- inside a string as a comment starter
    expect(findTenancyViolations(sql)).toEqual([]);
  });

  it("flags campaign table even when -- in string could confuse comment stripper", () => {
    const sql = `CREATE TABLE campaign (id uuid PRIMARY KEY, url text DEFAULT 'https://example.com--path', name text NOT NULL);`;
    // Without proper string awareness, the line comment stripper might eat the closing );
    expect(findTenancyViolations(sql)).toEqual(["campaign"]);
  });

  it("preserves dollar-quoted function body with -- and semicolons", () => {
    const sql = `CREATE OR REPLACE FUNCTION update_timestamp() RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW(); -- update timestamp
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TABLE campaign (id uuid PRIMARY KEY, name text NOT NULL);`;
    expect(findTenancyViolations(sql)).toEqual(["campaign"]);
  });

  it("preserves tagged dollar-quoted function body", () => {
    const sql = `CREATE OR REPLACE FUNCTION process_data() RETURNS void AS $func$
      BEGIN
        -- this is a comment in the function
        EXECUTE 'SELECT 1'; -- another comment
      END;
      $func$ LANGUAGE plpgsql;
      CREATE TABLE order_item (id uuid PRIMARY KEY, name text NOT NULL);`;
    expect(findTenancyViolations(sql)).toEqual(["order_item"]);
  });

  it("does not terminate string early on escaped quote", () => {
    const sql = `CREATE TABLE campaign (id uuid PRIMARY KEY, name text DEFAULT 'it''s a string', workspace_id uuid NOT NULL);`;
    expect(findTenancyViolations(sql)).toEqual([]);
  });

  it("handles realistic migration with comments and function", () => {
    const sql = `-- This is a migration
      CREATE OR REPLACE FUNCTION my_func() RETURNS void AS $$
      BEGIN
        -- Function comment with /* block marker
        RETURN;
      END;
      $$ LANGUAGE plpgsql;

      /* Real block comment */
      CREATE TABLE campaign (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
      ALTER TABLE campaign ENABLE ROW LEVEL SECURITY;`;
    expect(findTenancyViolations(sql)).toEqual([]);
    expect(findRlsViolations(sql)).toEqual([]);
  });
});
