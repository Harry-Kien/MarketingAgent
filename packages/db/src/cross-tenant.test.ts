// Task 12 (E8/E14): the exhaustive cross-workspace isolation backstop.
//
// Every earlier task (6, 7, 8, 10, 11) proved isolation for the tables it
// happened to add, by hand, with a hard-coded table list. This suite is
// different on purpose: it never hand-writes the set of workspace-owned
// tables or the set of composite foreign keys between them. Both are
// DISCOVERED from the live PostgreSQL catalog in a top-level `await` before
// any `describe`/`it` runs, so a migration added after this file is written
// (P2, a future task, anything) is covered automatically the next time this
// suite runs -- there is no list here for someone to forget to update.
//
// Does NOT replace tenant-scope.test.ts, rls.test.ts, tenant-role.test.ts,
// campaign-tenant.test.ts, content-tenant.test.ts, agent-registry-tenant.test.ts,
// outbox-privilege.test.ts or cross-workspace-fk.test.ts -- those stay, and
// several of them assert things (append-only triggers, specific privilege
// grants, the ADR-007 role-fix regressions) that are out of this file's
// scope on purpose. This file is the single place that proves the isolation
// claim holds for *every* table and *every* cross-table foreign key at once.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { newId } from "@smos/domain";
import { seedTwoWorkspaces, type TenantFixture } from "@smos/testing";
import { createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";
// Plain .mjs, not .js -- scripts/ is not a TypeScript package and the repo's
// relative-import guard (scripts/check-imports.mjs) only flags a literal
// ".js" extension, which this is not. GLOBAL_TABLES is the single allowlist
// scripts/check-migrations.mjs itself trusts; importing it (rather than
// retyping it here) means this suite's cross-check can never drift from the
// real guard.
import { GLOBAL_TABLES } from "../../../scripts/migration-guards.mjs";

// smos_app: the non-BYPASSRLS application role (ADR-007). Every isolation
// assertion in this file goes through this pool, via withTenant.
const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
// smos: the migration-owner superuser, which always bypasses RLS regardless
// of FORCE. Used only for seeding fixtures and reading pg_catalog /
// information_schema -- never for an isolation assertion itself.
const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const adminPool = createDbPool(adminUrl);

interface RlsRow {
  relname: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
}

interface PolicyRow {
  tablename: string;
  policyname: string;
  has_using: boolean;
  has_with_check: boolean;
}

interface FkPair {
  childTable: string;
  childCols: string[];
  parentTable: string;
  parentCols: string[];
}

async function discoverTenantTables(): Promise<string[]> {
  const r = await adminPool.query(
    `select table_name from information_schema.columns
     where table_schema = 'public' and column_name = 'workspace_id'
     order by table_name`,
  );
  return r.rows.map((row: { table_name: string }) => row.table_name);
}

async function discoverAllBaseTables(): Promise<string[]> {
  const r = await adminPool.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name`,
  );
  return r.rows.map((row: { table_name: string }) => row.table_name);
}

async function discoverRlsRows(): Promise<RlsRow[]> {
  const r = await adminPool.query(
    `select c.relname, c.relrowsecurity, c.relforcerowsecurity
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
     order by c.relname`,
  );
  return r.rows;
}

async function discoverPolicies(): Promise<PolicyRow[]> {
  const r = await adminPool.query(
    `select tablename, policyname, qual is not null as has_using, with_check is not null as has_with_check
     from pg_policies where schemaname = 'public' order by tablename, policyname`,
  );
  return r.rows;
}

/**
 * Every foreign key constraint in `public` whose child AND parent are both
 * workspace-owned (both appear in `tenantTables`), described by its exact
 * column tuples (via pg_constraint's conkey/confkey, not a text join over
 * information_schema, which produces a cartesian product for multi-column
 * constraints). A same-table-pair constraint with only one column
 * (workspace_id -> workspace.id, since `workspace` is never in
 * `tenantTables`) never reaches this function's result.
 */
async function discoverTenantToTenantFks(tenantTables: string[]): Promise<FkPair[]> {
  const r = await adminPool.query(`
    select
      cl.relname as child_table,
      array_agg(att.attname::text order by u.ord) as child_cols,
      fcl.relname as parent_table,
      array_agg(fatt.attname::text order by u.ord) as parent_cols
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_class fcl on fcl.oid = con.confrelid
    join lateral unnest(con.conkey) with ordinality as u(attnum, ord) on true
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = u.attnum
    join lateral unnest(con.confkey) with ordinality as fu(attnum, ord) on fu.ord = u.ord
    join pg_attribute fatt on fatt.attrelid = con.confrelid and fatt.attnum = fu.attnum
    where con.contype = 'f' and cl.relnamespace = 'public'::regnamespace
    group by con.conname, cl.relname, fcl.relname
    order by cl.relname, con.conname`);
  return (r.rows as { child_table: string; child_cols: string[]; parent_table: string; parent_cols: string[] }[])
    .filter((row) => tenantTables.includes(row.child_table) && tenantTables.includes(row.parent_table))
    .map((row) => ({
      childTable: row.child_table,
      childCols: row.child_cols,
      parentTable: row.parent_table,
      parentCols: row.parent_cols,
    }));
}

// --- Discovery happens once, at module load, via top-level await. it.each
// needs its arrays synchronously when `describe` bodies run (before any
// beforeAll), so this cannot be deferred into a hook. ---
const TENANT_TABLES = await discoverTenantTables();
const ALL_TABLES = await discoverAllBaseTables();
const RLS_ROWS = await discoverRlsRows();
const POLICIES = await discoverPolicies();
const FK_PAIRS = await discoverTenantToTenantFks(TENANT_TABLES);

// Committed, not derived. Catalog discovery is exhaustive by construction
// for a table/FK that's ADDED (it's simply found), but the opposite failure
// mode -- a migration that silently DROPS a workspace_id column or a
// composite tenant-to-tenant FK -- is invisible to discovery: the removed
// item just stops appearing, `it.each` emits one fewer case, and the run
// reports fewer tests with zero failures. Pinning the exact expected result
// here turns that into a loud failure that names what disappeared (a
// toEqual diff), instead of a quiet shrink nobody notices.
//
// Changing either list below is a DELIBERATE act and must happen in the
// SAME commit as the schema change that adds or removes a workspace-owned
// table or a composite tenant-to-tenant foreign key -- never as a side
// effect of something else, and never "just to make the suite pass" without
// first confirming the underlying schema change is intentional.
// P2 task 6 adds agent_run, tool_call, run_checkpoint -- updated in the same
// commit as infra/migrations/0024_agent_run.sql per this list's own rule
// above.
// P4 task 3 (infra/migrations/0028_integration.sql) adds integration,
// credential_reference, webhook_delivery, event, metric -- all five
// workspace-owned, per this list's own rule, updated in the same commit as
// the migration that adds them.
const EXPECTED_TENANT_TABLES = [
  "agent_definition", "agent_run", "agent_version", "approval_decision", "approval_request",
  "audit_log", "campaign", "content_item", "content_version", "credential_reference",
  "event", "goal", "integration", "metric", "outbox",
  "publication", "run_checkpoint", "source_citation", "tool_call", "webhook_delivery",
].toSorted();

const EXPECTED_FK_PAIRS = [
  "agent_run->agent_version",
  "agent_run->campaign",
  "agent_version->agent_definition",
  "approval_decision->approval_request",
  "approval_request->campaign",
  "approval_request->content_version",
  "campaign->goal",
  "content_item->campaign",
  "content_version->content_item",
  "credential_reference->integration",
  "event->publication",
  "metric->campaign",
  "publication->approval_decision",
  "publication->campaign",
  "publication->content_version",
  "run_checkpoint->agent_run",
  "source_citation->content_version",
  "tool_call->agent_run",
].toSorted();

let a: TenantFixture;
let b: TenantFixture;

beforeAll(async () => {
  ({ a, b } = await seedTwoWorkspaces(adminPool));
});

afterAll(async () => {
  // Best-effort partial cleanup. goal/campaign/content_item/content_version/
  // source_citation/approval_request/publication/workspace/user_account are
  // NOT deletable here: approval_decision and audit_log are immutable by
  // design (0007_approval.sql / 0001_core_tenancy.sql -- their BEFORE
  // DELETE triggers raise unconditionally, for any role, including a
  // superuser), and every one of those tables sits in the plain-FK ancestry
  // (approval_request -> campaign -> goal -> workspace, content_version ->
  // content_item, publication -> all three) that a live approval_decision
  // row pins in place -- none of those FKs declare ON DELETE CASCADE. This
  // is not new: rls.test.ts, tenant-role.test.ts and cross-workspace-fk.test.ts
  // already accept the same constraint and never delete their seeded rows
  // either. What IS safely deletable (nothing else references it) is
  // removed here so this suite's own footprint is at least bounded to what
  // the schema actually allows.
  for (const ws of [a, b].filter((w): w is TenantFixture => w !== undefined)) {
    // P2 task 6: tool_call and run_checkpoint reference agent_run, and
    // agent_run itself references agent_version -- children must be deleted
    // before their parents or the FK refuses the delete (silently, via the
    // .catch below, which would otherwise leak agent_version/agent_definition
    // rows across runs instead of actually cleaning them up).
    await adminPool.query("delete from tool_call where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from run_checkpoint where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from agent_run where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from agent_version where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from agent_definition where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from outbox where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    // P4 task 3: none of these five are referenced by anything else seeded
    // above (credential_reference -> integration cascades on delete), so
    // order among them doesn't matter, only that they come before the
    // integration delete below.
    await adminPool.query("delete from credential_reference where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from event where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from metric where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from webhook_delivery where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from integration where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
  }
  await pool.end();
  await adminPool.end();
});

/**
 * One bound value per column. `sql`, when present, wraps that column's own
 * placeholder in a SQL expression instead of inserting the value verbatim --
 * used only for publication.content_hash, which must equal
 * sha256(publication_content) exactly (publication_content_hash_check,
 * 0011_publication_immutability.sql): the same text is bound twice (once
 * plain for publication_content, once wrapped in digest(...) for
 * content_hash) so the two columns can never disagree.
 */
interface Cell {
  value: unknown;
  sql?: (placeholder: string) => string;
}

/** A single valid row for `table`, entirely inside `ws`'s own workspace. */
function buildProbeRow(table: string, ws: TenantFixture, id: string): { columns: string[]; cells: Cell[] } {
  switch (table) {
    case "goal":
      return {
        columns: ["id", "workspace_id", "statement"],
        cells: [{ value: id }, { value: ws.workspaceId }, { value: "e12 probe goal" }],
      };
    case "campaign":
      return {
        columns: ["id", "workspace_id", "goal_id", "name", "state"],
        cells: [
          { value: id }, { value: ws.workspaceId }, { value: ws.goalId },
          { value: `e12-probe-campaign-${id}` }, { value: "DRAFT" },
        ],
      };
    case "content_item":
      return {
        columns: ["id", "workspace_id", "campaign_id", "kind", "title"],
        cells: [
          { value: id }, { value: ws.workspaceId }, { value: ws.campaignId },
          { value: "social_post" }, { value: `e12-probe-item-${id}` },
        ],
      };
    case "content_version":
      return {
        columns: ["id", "workspace_id", "content_item_id", "version_number", "body"],
        cells: [{ value: id }, { value: ws.workspaceId }, { value: ws.contentItemId }, { value: 99 }, { value: "e12 probe body" }],
      };
    case "source_citation":
      return {
        columns: ["id", "workspace_id", "content_version_id", "url", "accessed_at", "excerpt", "verification_status"],
        cells: [
          { value: id }, { value: ws.workspaceId }, { value: ws.contentVersionId },
          { value: "https://e12-probe.test" }, { value: new Date() }, { value: "e12 excerpt" }, { value: "VERIFIED" },
        ],
      };
    case "approval_request":
      return {
        columns: ["id", "workspace_id", "campaign_id", "content_version_id", "target_channel"],
        cells: [
          { value: id }, { value: ws.workspaceId }, { value: ws.campaignId },
          { value: ws.contentVersionId }, { value: "meta_page" },
        ],
      };
    case "approval_decision":
      return {
        columns: ["id", "workspace_id", "approval_request_id", "actor_user_id", "decision", "reason"],
        cells: [
          { value: id }, { value: ws.workspaceId }, { value: ws.approvalRequestId },
          { value: ws.userId }, { value: "approve" }, { value: "e12 probe decision" },
        ],
      };
    case "publication": {
      const text = "e12 probe pub";
      return {
        columns: [
          "id", "workspace_id", "campaign_id", "content_version_id", "approval_decision_id",
          "publication_content", "content_hash", "idempotency_key", "target_channel", "state",
        ],
        cells: [
          { value: id }, { value: ws.workspaceId }, { value: ws.campaignId },
          { value: ws.contentVersionId }, { value: ws.approvalDecisionId },
          { value: text },
          { value: text, sql: (p) => `encode(digest(${p}, 'sha256'), 'hex')` },
          { value: `e12-key-${id}` }, { value: "meta_page" }, { value: "prepared" },
        ],
      };
    }
    case "agent_definition":
      // "orchestrator", never "content": seedOne() already used "content" for
      // this workspace, and (workspace_id, role) is UNIQUE.
      return {
        columns: ["id", "workspace_id", "role", "mission"],
        cells: [{ value: id }, { value: ws.workspaceId }, { value: "orchestrator" }, { value: "e12 probe mission" }],
      };
    case "agent_version":
      // activated: false. seedOne() already activated version 1 for this
      // agent_definition, and at most one activated version per definition
      // is enforced (0015); a probe row has no reason to fight that.
      return {
        columns: [
          "id", "workspace_id", "agent_definition_id", "version_number",
          "activated", "prompt_version", "model_version", "budget_usd",
        ],
        cells: [
          { value: id }, { value: ws.workspaceId }, { value: ws.agentDefinitionId }, { value: 99 },
          { value: false }, { value: "p1" }, { value: "m1" }, { value: 1.0 },
        ],
      };
    case "outbox":
      return {
        columns: ["id", "workspace_id", "event_type", "correlation_id"],
        cells: [{ value: id }, { value: ws.workspaceId }, { value: "e12.probe.event" }, { value: id }],
      };
    case "audit_log":
      return {
        columns: ["id", "workspace_id", "event_type", "actor_kind"],
        cells: [{ value: id }, { value: ws.workspaceId }, { value: "e12.probe.audit" }, { value: "system" }],
      };
    case "agent_run":
      return {
        columns: ["id", "workspace_id", "agent_version_id", "campaign_id", "state", "prompt_version", "model_version"],
        cells: [
          { value: id }, { value: ws.workspaceId }, { value: ws.agentVersionId }, { value: ws.campaignId },
          { value: "pending" }, { value: "e12-probe-prompt" }, { value: "e12-probe-model" },
        ],
      };
    case "tool_call":
      return {
        columns: ["id", "workspace_id", "agent_run_id", "tool_name", "allowed"],
        cells: [{ value: id }, { value: ws.workspaceId }, { value: ws.agentRunId }, { value: "e12_probe_tool" }, { value: true }],
      };
    case "run_checkpoint":
      return {
        columns: ["id", "workspace_id", "agent_run_id", "step_name"],
        cells: [{ value: id }, { value: ws.workspaceId }, { value: ws.agentRunId }, { value: `e12-probe-step-${id}` }],
      };
    // P4 task 3 (infra/migrations/0028_integration.sql):
    case "integration":
      return {
        columns: ["id", "workspace_id", "provider", "status"],
        cells: [{ value: id }, { value: ws.workspaceId }, { value: `e12-probe-provider-${id}` }, { value: "connected" }],
      };
    case "credential_reference":
      return {
        columns: ["id", "workspace_id", "integration_id", "vault_key"],
        cells: [{ value: id }, { value: ws.workspaceId }, { value: ws.integrationId }, { value: `vault://e12-probe/${id}` }],
      };
    case "webhook_delivery":
      return {
        columns: ["id", "workspace_id", "provider", "external_id", "signature_ok", "payload"],
        cells: [
          { value: id }, { value: ws.workspaceId }, { value: "meta" },
          { value: `e12-probe-ext-${id}` }, { value: true }, { value: "{}", sql: (p) => `${p}::jsonb` },
        ],
      };
    case "event":
      return {
        columns: ["id", "workspace_id", "publication_id", "event_type", "occurred_at"],
        cells: [
          { value: id }, { value: ws.workspaceId }, { value: ws.publicationId },
          { value: "e12.probe.event" }, { value: new Date() },
        ],
      };
    case "metric":
      return {
        columns: [
          "id", "workspace_id", "campaign_id", "name", "value",
          "freshness_at", "attribution_model", "attribution_window", "confidence",
        ],
        cells: [
          { value: id }, { value: ws.workspaceId }, { value: ws.campaignId }, { value: "e12_probe_metric" }, { value: 1 },
          { value: new Date() }, { value: "last_touch" }, { value: "7d" }, { value: "low" },
        ],
      };
    default:
      // Fails loudly rather than silently skipping: a table discovered from
      // the catalog with no probe-row builder here would otherwise pass this
      // suite's INSERT check by never being tested at all.
      throw new Error(
        `cross-tenant.test.ts: no probe-row builder registered for table "${table}". ` +
          "Add one to buildProbeRow so the exhaustive suite actually covers it.",
      );
  }
}

function toInsertSql(table: string, row: { columns: string[]; cells: Cell[] }): { text: string; values: unknown[] } {
  const values = row.cells.map((c) => c.value);
  const placeholders = row.cells.map((c, i) => {
    const p = `$${i + 1}`;
    return c.sql ? c.sql(p) : p;
  });
  return { text: `insert into ${table} (${row.columns.join(", ")}) values (${placeholders.join(", ")})`, values };
}

/** Maps a composite FK's non-workspace_id column to the matching TenantFixture id. */
function fixtureIdForColumn(ws: TenantFixture, column: string): string {
  const map: Record<string, keyof TenantFixture> = {
    goal_id: "goalId",
    campaign_id: "campaignId",
    content_item_id: "contentItemId",
    content_version_id: "contentVersionId",
    approval_request_id: "approvalRequestId",
    approval_decision_id: "approvalDecisionId",
    agent_definition_id: "agentDefinitionId",
    agent_version_id: "agentVersionId",
    agent_run_id: "agentRunId",
    // P4 task 3 (infra/migrations/0028_integration.sql):
    integration_id: "integrationId",
    publication_id: "publicationId",
  };
  const key = map[column];
  if (!key) {
    throw new Error(`cross-tenant.test.ts: no fixture id mapping for FK column "${column}"`);
  }
  return ws[key];
}

describe("E8/E14: every discovered workspace-owned table is isolated", () => {
  it(`discovered exactly the committed set of ${EXPECTED_TENANT_TABLES.length} workspace-owned table(s)`, () => {
    // This is the ADD side of the exhaustiveness claim (a new workspace_id
    // column is picked up automatically) crossed with the REMOVE side (a
    // dropped one is caught immediately, by name, via the toEqual diff)
    // rather than just shrinking `it.each`'s case count silently.
    expect(TENANT_TABLES.toSorted()).toEqual(EXPECTED_TENANT_TABLES);
  });

  it.each(TENANT_TABLES)("%s: RLS is both enabled and forced", (table) => {
    const row = RLS_ROWS.find((r) => r.relname === table);
    expect(row, `${table} has no pg_class row`).toBeDefined();
    expect(row?.relrowsecurity, `${table}.relrowsecurity`).toBe(true);
    expect(row?.relforcerowsecurity, `${table}.relforcerowsecurity`).toBe(true);
  });

  it.each(TENANT_TABLES)("%s: its tenant-isolation policy carries both USING and WITH CHECK", (table) => {
    const tablePolicies = POLICIES.filter((p) => p.tablename === table);
    expect(tablePolicies.length, `${table} has at least one policy`).toBeGreaterThan(0);
    for (const p of tablePolicies) {
      expect(p.has_using, `${table}.${p.policyname} has a USING expression`).toBe(true);
      expect(p.has_with_check, `${table}.${p.policyname} has a WITH CHECK expression`).toBe(true);
    }
  });

  it.each(TENANT_TABLES)("%s: workspace B's rows are invisible from workspace A's scope", async (table) => {
    // The row belongs to B for certain (bypasses RLS to fetch it), independent
    // of anything the isolation policy does.
    const bRow = await adminPool.query(`select id from ${table} where workspace_id = $1 limit 1`, [b.workspaceId]);
    expect(bRow.rowCount, `fixture seeded a ${table} row for workspace B`).toBe(1);
    const bRowId: string = bRow.rows[0].id;

    await withTenant(pool, a.workspaceId, async (tx) => {
      // A can see its own rows in this table (sanity: RLS isn't hiding
      // everything, only what's out of scope).
      const own = await tx.query(`select count(*)::int as n from ${table} where workspace_id = $1`, [a.workspaceId]);
      expect(own.rows[0].n, `A sees its own ${table} rows`).toBeGreaterThan(0);

      // 1. Plain select by primary key -- no workspace_id anywhere in the
      // query text; RLS alone must hide it.
      const plain = await tx.query(`select id from ${table} where id = $1`, [bRowId]);
      expect(plain.rowCount, `${table}: plain select by id`).toBe(0);

      // 2. Explicit WHERE workspace_id = B -- proves RLS cannot be defeated
      // by naming the other workspace directly.
      const explicit = await tx.query(`select count(*)::int as n from ${table} where workspace_id = $1`, [b.workspaceId]);
      expect(explicit.rows[0].n, `${table}: explicit WHERE workspace_id = B`).toBe(0);

      // 3. Via a subquery -- proves the policy applies to the table
      // wherever it is scanned, not only at the outermost query level.
      const sub = await tx.query(
        `select count(*)::int as n from ${table} where id in (select id from ${table} where workspace_id = $1)`,
        [b.workspaceId],
      );
      expect(sub.rows[0].n, `${table}: via subquery`).toBe(0);
    });
  });

  it.each(TENANT_TABLES)("%s: an INSERT tagged with workspace B from workspace A's scope is refused", async (table) => {
    const row = buildProbeRow(table, b, newId());
    const { text, values } = toInsertSql(table, row);
    await expect(withTenant(pool, a.workspaceId, (tx) => tx.query(text, values))).rejects.toThrow(
      /row-level security|violates/i,
    );
  });
});

describe("E14: cross-table composite foreign keys refuse a cross-workspace parent", () => {
  it(`discovered exactly the committed set of ${EXPECTED_FK_PAIRS.length} composite tenant-to-tenant foreign key(s)`, () => {
    // Same shape as the tenant-table pin above: a dropped composite FK
    // (e.g. reverting to a plain single-column REFERENCES, or dropping the
    // constraint outright) makes discovery return one fewer pair, which
    // `it.each` would otherwise turn into "one fewer test, zero failures."
    // This assertion is what makes that loud instead, and names the exact
    // pair that vanished via the toEqual diff.
    const discovered = FK_PAIRS.map((p) => `${p.childTable}->${p.parentTable}`).toSorted();
    expect(discovered).toEqual(EXPECTED_FK_PAIRS);
  });

  it.each(FK_PAIRS)("$childTable -> $parentTable is composite (includes workspace_id)", ({ childCols }) => {
    expect(childCols.length).toBeGreaterThanOrEqual(2);
    expect(childCols).toContain("workspace_id");
  });

  it.each(FK_PAIRS)("$childTable -> $parentTable refuses a parent row from a different workspace", async ({ childTable, childCols, parentTable }) => {
    const fkColumn = childCols.find((c) => c !== "workspace_id");
    if (!fkColumn) throw new Error(`${childTable} -> ${parentTable}: composite FK has no non-workspace_id column`);

    // A row that is otherwise entirely valid for workspace B, except its FK
    // column is hijacked to point at workspace A's parent row instead of B's
    // own. Inserted from workspace B's own scope, so RLS's WITH CHECK on
    // <childTable> passes trivially (workspace_id = B = session scope) --
    // any rejection can only come from the FK itself.
    const row = buildProbeRow(childTable, b, newId());
    const colIndex = row.columns.indexOf(fkColumn);
    expect(colIndex, `${childTable} probe row has a ${fkColumn} column`).toBeGreaterThanOrEqual(0);
    row.cells[colIndex] = { value: fixtureIdForColumn(a, fkColumn) };
    const { text, values } = toInsertSql(childTable, row);

    await expect(withTenant(pool, b.workspaceId, (tx) => tx.query(text, values))).rejects.toThrow(/foreign key|violates/i);
  });
});

describe("E8/E14: proven once, not per table", () => {
  it("reading a specific row of A's by primary key from B's scope returns nothing, not an error (no existence leak)", async () => {
    const r = await withTenant(pool, b.workspaceId, (tx) => tx.query("select id from campaign where id = $1", [a.campaignId]));
    expect(r.rowCount).toBe(0);
    expect(r.rows).toEqual([]);
  });

  it("the app role smos_app has no BYPASSRLS and is not a superuser", async () => {
    const r = await adminPool.query("select rolbypassrls, rolsuper from pg_roles where rolname = 'smos_app'");
    expect(r.rows[0].rolbypassrls).toBe(false);
    expect(r.rows[0].rolsuper).toBe(false);
  });

  it("with app.workspace_id unset entirely, a read returns zero rows rather than everything", async () => {
    // A dedicated, never-before-used connection, not one borrowed from the
    // shared `pool` -- every other test in this file drives withTenant,
    // which sets app.workspace_id LOCAL to its own transaction; once a
    // connection has had that GUC touched at all, PostgreSQL's post-commit
    // "reset" value for an undeclared placeholder param is '' (empty
    // string), not NULL, and casting '' to uuid raises an error rather than
    // filtering cleanly. A connection that has truly never touched the
    // setting reads NULL from current_setting(..., true), so `workspace_id
    // = NULL` is never true and the policy fails CLOSED with an ordinary
    // empty result -- proving the "completely absent" case specifically,
    // not the "explicitly reset" case.
    const fresh = new pg.Client({ connectionString: url });
    await fresh.connect();
    try {
      const r = await fresh.query("select count(*)::int as n from campaign");
      expect(r.rows[0].n).toBe(0);
    } finally {
      await fresh.end();
    }
  });

  it("GLOBAL_TABLES cross-check: every base table is either workspace-owned or an explicitly reviewed global table", () => {
    const unaccounted = ALL_TABLES.filter((t) => !TENANT_TABLES.includes(t) && !GLOBAL_TABLES.includes(t));
    // Fix round 1 (task-12-report.md): `schema_migration` -- created
    // procedurally by scripts/apply-migrations.mjs, never via a tracked
    // migration file -- is now listed in GLOBAL_TABLES
    // (scripts/migration-guards.mjs), so the allowlist tells the truth
    // about every table that actually exists and this backstop expects a
    // clean, empty gap. Any NEW ungoverned table added by a future
    // migration still fails this assertion immediately and must be triaged
    // as either workspace-owned or deliberately added to GLOBAL_TABLES.
    expect(unaccounted).toEqual([]);
  });
});
