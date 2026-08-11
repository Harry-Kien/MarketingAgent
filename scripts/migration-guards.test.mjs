import { describe, expect, it } from "vitest";
import {
  findTenancyViolations,
  findRlsViolations,
  GLOBAL_TABLES,
  parseFile,
  collectFileFacts,
  computeViolations,
} from "./migration-guards.mjs";

/** Helper: build the {name, facts} shape computeViolations expects for a set of files. */
function factsFor(files) {
  return Object.entries(files).map(([name, sql]) => ({ name, facts: collectFileFacts(sql) }));
}

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

describe("regression: statement boundary detection", () => {
  it("detects tables even when prior statement has unterminated string", () => {
    const sql = `CREATE TABLE broken (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, note text DEFAULT 'unterminated string starts here
      CREATE TABLE clean_table (id uuid PRIMARY KEY, name text NOT NULL);`;
    expect(findTenancyViolations(sql)).toContain("clean_table");
  });

  it("detects tables even when prior statement has unterminated paren", () => {
    const sql = `CREATE TABLE broken (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, note text, extra (
      CREATE TABLE clean_table (id uuid PRIMARY KEY, name text NOT NULL);`;
    expect(findTenancyViolations(sql)).toContain("clean_table");
  });

  it("detects RLS across files when ALTER in different statement", () => {
    const sql = `CREATE TABLE campaign (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
      CREATE TABLE other (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
      ALTER TABLE campaign ENABLE ROW LEVEL SECURITY;`;
    expect(findRlsViolations(sql)).toEqual(["other"]);
  });

  it("does not split on semicolon inside dollar-quoted function body", () => {
    const sql = `CREATE OR REPLACE FUNCTION test() AS $$
      BEGIN
        EXECUTE 'SELECT 1; SELECT 2';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TABLE campaign (id uuid PRIMARY KEY, name text NOT NULL);`;
    expect(findTenancyViolations(sql)).toEqual(["campaign"]);
  });

  it("does not split on semicolon inside DEFAULT string", () => {
    const sql = `CREATE TABLE campaign (
      id uuid PRIMARY KEY,
      note text DEFAULT 'see https://example.com;docs',
      name text NOT NULL
    );`;
    expect(findTenancyViolations(sql)).toEqual(["campaign"]);
  });

  it("does not split on semicolon inside CHECK constraint parens", () => {
    const sql = `CREATE TABLE campaign (
      id uuid PRIMARY KEY,
      status text CHECK (status IN ('active'; 'deleted')),
      name text NOT NULL
    );`;
    expect(findTenancyViolations(sql)).toEqual(["campaign"]);
  });
});

describe("fail-closed per-file parsing: unterminated constructs never hide later files", () => {
  it("unterminated $$ in file A does not hide a table missing workspace_id in file B", () => {
    const fileA = `CREATE OR REPLACE FUNCTION broken() RETURNS TRIGGER AS $$
      BEGIN
        RETURN NEW;
      -- forgot to close the dollar-quote
    `;
    const fileB = `CREATE TABLE campaign (id uuid PRIMARY KEY, name text NOT NULL);`;
    const { tenancyViolations } = computeViolations(
      factsFor({ "0001_broken.sql": fileA, "0002_campaign.sql": fileB })
    );
    expect(tenancyViolations).toContain("campaign");
  });

  it("unterminated $tag$ in file A does not hide a table in file B", () => {
    const fileA = `CREATE OR REPLACE FUNCTION broken() RETURNS TRIGGER AS $body$
      BEGIN
        RETURN NEW;
      -- forgot to close the tagged dollar-quote
    `;
    const fileB = `CREATE TABLE campaign (id uuid PRIMARY KEY, name text NOT NULL);`;
    const { tenancyViolations } = computeViolations(
      factsFor({ "0001_broken.sql": fileA, "0002_campaign.sql": fileB })
    );
    expect(tenancyViolations).toContain("campaign");
  });

  it("unterminated ' in file A does not hide a table in file B", () => {
    const fileA = `CREATE TABLE broken (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, note text DEFAULT 'unterminated`;
    const fileB = `CREATE TABLE campaign (id uuid PRIMARY KEY, name text NOT NULL);`;
    const { tenancyViolations } = computeViolations(
      factsFor({ "0001_broken.sql": fileA, "0002_campaign.sql": fileB })
    );
    expect(tenancyViolations).toContain("campaign");
  });

  it("unterminated ( in file A does not hide a table in file B", () => {
    const fileA = `CREATE TABLE broken (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, extra (nested`;
    const fileB = `CREATE TABLE campaign (id uuid PRIMARY KEY, name text NOT NULL);`;
    const { tenancyViolations } = computeViolations(
      factsFor({ "0001_broken.sql": fileA, "0002_campaign.sql": fileB })
    );
    expect(tenancyViolations).toContain("campaign");
  });

  it("unterminated /* in file A does not hide a table in file B", () => {
    const fileA = `CREATE TABLE broken (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
      /* comment that never closes`;
    const fileB = `CREATE TABLE campaign (id uuid PRIMARY KEY, name text NOT NULL);`;
    const { tenancyViolations } = computeViolations(
      factsFor({ "0001_broken.sql": fileA, "0002_campaign.sql": fileB })
    );
    expect(tenancyViolations).toContain("campaign");
  });

  it("reports each unterminated file as its own violation (fail closed)", () => {
    const cases = {
      "unterminated_dollar.sql": `CREATE OR REPLACE FUNCTION f() RETURNS void AS $$ BEGIN RETURN; `,
      "unterminated_tagged_dollar.sql": `CREATE OR REPLACE FUNCTION f() RETURNS void AS $tag$ BEGIN RETURN; `,
      "unterminated_string.sql": `CREATE TABLE t (id uuid, note text DEFAULT 'unterminated`,
      "unterminated_paren.sql": `CREATE TABLE t (id uuid, extra (nested`,
      "unterminated_comment.sql": `CREATE TABLE t (id uuid); /* never closes`,
    };
    for (const [name, sql] of Object.entries(cases)) {
      const { unterminated } = collectFileFacts(sql);
      expect(unterminated, `${name} should be flagged unterminated`).not.toBeNull();
    }
    const { unparseableFiles } = computeViolations(factsFor(cases));
    const flaggedFiles = unparseableFiles.map((f) => f.file);
    for (const name of Object.keys(cases)) {
      expect(flaggedFiles).toContain(name);
    }
  });

  it("parseFile reports the specific open construct for each unterminated case", () => {
    expect(parseFile(`CREATE TABLE t (id uuid, note text DEFAULT 'oops`).unterminated.construct).toMatch(/string/i);
    expect(parseFile(`CREATE TABLE t (id uuid, extra (nested`).unterminated.construct).toMatch(/paren/i);
    expect(parseFile(`CREATE TABLE t (id uuid); /* oops`).unterminated.construct).toMatch(/comment/i);
    expect(parseFile(`CREATE FUNCTION f() AS $$ BEGIN RETURN; `).unterminated.construct).toMatch(/dollar/i);
    expect(parseFile(`CREATE FUNCTION f() AS $tag$ BEGIN RETURN; `).unterminated.construct).toMatch(/dollar/i);
  });
});

describe("computeViolations: cross-file RLS aggregation still works", () => {
  it("reports clean when CREATE is in one file and ENABLE ROW LEVEL SECURITY is in another", () => {
    const fileA = `CREATE TABLE campaign (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);`;
    const fileB = `ALTER TABLE campaign ENABLE ROW LEVEL SECURITY;`;
    const { tenancyViolations, rlsViolations, unparseableFiles } = computeViolations(
      factsFor({ "0001_campaign.sql": fileA, "0002_rls.sql": fileB })
    );
    expect(tenancyViolations).toEqual([]);
    expect(rlsViolations).toEqual([]);
    expect(unparseableFiles).toEqual([]);
  });

  it("still flags a table whose RLS-enabling ALTER never appears in any file", () => {
    const fileA = `CREATE TABLE campaign (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);`;
    const fileB = `CREATE TABLE other (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
      ALTER TABLE other ENABLE ROW LEVEL SECURITY;`;
    const { rlsViolations } = computeViolations(factsFor({ "0001.sql": fileA, "0002.sql": fileB }));
    expect(rlsViolations).toEqual(["campaign"]);
  });
});

describe("collectFileFacts: statement boundaries within a single well-formed file", () => {
  it("does not split on ; inside a $$ trigger body", () => {
    const sql = `CREATE OR REPLACE FUNCTION touch() RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW(); SELECT 1;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TABLE campaign (id uuid PRIMARY KEY, name text NOT NULL);`;
    const { tables, unterminated } = collectFileFacts(sql);
    expect(unterminated).toBeNull();
    expect(tables.map((t) => t.name)).toEqual(["campaign"]);
  });

  it("does not split on ; inside a DEFAULT string literal", () => {
    const sql = `CREATE TABLE campaign (
      id uuid PRIMARY KEY,
      note text DEFAULT 'see https://example.com;docs',
      workspace_id uuid NOT NULL
    );`;
    const { tables, unterminated } = collectFileFacts(sql);
    expect(unterminated).toBeNull();
    expect(tables).toEqual([{ name: "campaign", hasWorkspaceId: true }]);
  });

  it("does not split on ; inside a parenthesised CHECK constraint", () => {
    const sql = `CREATE TABLE campaign (
      id uuid PRIMARY KEY,
      status text CHECK (status IN ('active'; 'deleted')),
      workspace_id uuid NOT NULL
    );`;
    const { tables, unterminated } = collectFileFacts(sql);
    expect(unterminated).toBeNull();
    expect(tables).toEqual([{ name: "campaign", hasWorkspaceId: true }]);
  });
});

describe("collectFileFacts: earlier bypasses stay closed", () => {
  it("flags a table with commented-out workspace_id", () => {
    const sql = `CREATE TABLE campaign (
      id uuid PRIMARY KEY,
      -- workspace_id uuid NOT NULL,
      name text NOT NULL
    );`;
    const { tables } = collectFileFacts(sql);
    expect(tables).toEqual([{ name: "campaign", hasWorkspaceId: false }]);
  });

  it("does not count a commented-out ALTER TABLE as enabling RLS", () => {
    const sql = `CREATE TABLE campaign (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
      -- ALTER TABLE campaign ENABLE ROW LEVEL SECURITY;`;
    const { tables, rlsEnabled } = collectFileFacts(sql);
    expect(tables.map((t) => t.name)).toEqual(["campaign"]);
    expect(rlsEnabled).toEqual([]);
  });

  it("does not let /* inside a string literal swallow the next table", () => {
    const sql = `CREATE TABLE settings (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, value text DEFAULT 'weird /* value');
      /* real comment */
      CREATE TABLE campaign (id uuid PRIMARY KEY, name text NOT NULL);`;
    const { tables } = collectFileFacts(sql);
    expect(tables.map((t) => t.name)).toEqual(["settings", "campaign"]);
  });

  it("does not let -- inside a string literal eat the closing paren", () => {
    const sql = `CREATE TABLE campaign (id uuid PRIMARY KEY, url text DEFAULT 'https://example.com--path', workspace_id uuid NOT NULL);`;
    const { tables, unterminated } = collectFileFacts(sql);
    expect(unterminated).toBeNull();
    expect(tables).toEqual([{ name: "campaign", hasWorkspaceId: true }]);
  });
});

describe("computeViolations: schema qualification", () => {
  it("flags a schema-qualified table missing workspace_id", () => {
    const sql = `CREATE TABLE public.campaign (id uuid PRIMARY KEY, name text NOT NULL);`;
    const { tenancyViolations } = computeViolations(factsFor({ "0001.sql": sql }));
    expect(tenancyViolations).toEqual(["campaign"]);
  });

  it("exempts a schema-qualified GLOBAL table", () => {
    const sql = `CREATE TABLE public.workspace (id uuid PRIMARY KEY, name text NOT NULL);`;
    expect(GLOBAL_TABLES).toContain("workspace");
    const { tenancyViolations, rlsViolations } = computeViolations(factsFor({ "0001.sql": sql }));
    expect(tenancyViolations).toEqual([]);
    expect(rlsViolations).toEqual([]);
  });
});

describe("computeViolations: realistic clean two-file migration set", () => {
  it("reports clean for a tenant table with RLS in one file and a $$ trigger in another", () => {
    const fileA = `-- Campaign table for tenant campaigns
      CREATE TABLE campaign (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES workspace(id),
        name text NOT NULL
      );
      ALTER TABLE campaign ENABLE ROW LEVEL SECURITY;
      CREATE POLICY campaign_isolation ON campaign
        USING (workspace_id = current_setting('app.workspace_id')::uuid);`;
    const fileB = `-- Reusable updated_at trigger
      CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW(); -- bump timestamp
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER campaign_set_updated_at BEFORE UPDATE ON campaign
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();`;
    const { tenancyViolations, rlsViolations, unparseableFiles } = computeViolations(
      factsFor({ "0001_campaign.sql": fileA, "0002_trigger.sql": fileB })
    );
    expect(tenancyViolations).toEqual([]);
    expect(rlsViolations).toEqual([]);
    expect(unparseableFiles).toEqual([]);
  });
});
