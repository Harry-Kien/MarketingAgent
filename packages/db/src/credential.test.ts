// P4 Task 3 (E16): integration, credential_reference, webhook_delivery,
// event and metric -- infra/migrations/0028_integration.sql. This file
// proves the invariants specific to this migration that cross-tenant.test.ts's
// generic, catalog-driven suite does not: the exact (secret-free) column
// shape of credential_reference, that a cross-tenant READ and a cross-tenant
// WRITE (both the plain RLS form and the composite-FK-hijack form) are both
// refused as smos_app, that metric cannot exist without freshness/
// attribution, that event tolerates an out-of-order webhook (no matching
// publication yet), and that webhook_delivery records a bad signature rather
// than silently dropping it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTwoWorkspaces, type TenantFixture } from "@smos/testing";
import { createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);

const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);

let a: TenantFixture;
let b: TenantFixture;

beforeAll(async () => {
  ({ a, b } = await seedTwoWorkspaces(adminPool));
});

afterAll(async () => {
  for (const ws of [a, b]) {
    await adminPool.query("delete from credential_reference where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from event where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from metric where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    await adminPool.query("delete from webhook_delivery where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
    // Credential vault (0036_vault_secret.sql): seedTwoWorkspaces now seeds
    // one placeholder vault_secret row per workspace too.
    await adminPool.query("delete from vault_secret where workspace_id = $1", [ws.workspaceId]).catch(() => undefined);
  }
  await pool.end();
  await adminPool.end();
});

const NEW_TABLES = ["integration", "credential_reference", "webhook_delivery", "event", "metric"];

describe("E16: RLS is enabled and forced on every new table", () => {
  it.each(NEW_TABLES)("%s", async (table) => {
    const r = await adminPool.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where relname = $1",
      [table],
    );
    expect(r.rows, `${table} has no pg_class row`).toHaveLength(1);
    expect(r.rows[0].relrowsecurity, `${table}.relrowsecurity`).toBe(true);
    expect(r.rows[0].relforcerowsecurity, `${table}.relforcerowsecurity`).toBe(true);
  });
});

describe("E16: smos_app has no DELETE grant on any of the five new tables", () => {
  it.each(NEW_TABLES)("%s", async (table) => {
    const r = await adminPool.query(
      `select privilege_type from information_schema.role_table_grants
       where table_name = $1 and grantee = 'smos_app'`,
      [table],
    );
    const privileges = r.rows.map((row: { privilege_type: string }) => row.privilege_type);
    expect(privileges, `${table} grants`).not.toContain("DELETE");
    // Late-review CRITICAL 2 / IMPORTANT 4 narrowed two of these five from
    // {SELECT, INSERT, UPDATE} to {SELECT, INSERT}: webhook_delivery is an
    // append-only receipt of what actually arrived (0032) and metric is an
    // immutable observation at a fixed instant (0034), so neither has any
    // legitimate UPDATE at all. This pin is tightened rather than relaxed --
    // re-granting UPDATE on either fails here.
    const expected =
      table === "webhook_delivery" || table === "metric"
        ? ["INSERT", "SELECT"]
        : ["INSERT", "SELECT", "UPDATE"];
    expect(privileges.toSorted(), `${table} grants`).toEqual(expected);
  });
});

describe("E16 tenant-aware credentials: stores only a vault pointer, never a secret", () => {
  it("credential_reference has vault_key and no secret-shaped column", async () => {
    const cols = await adminPool.query(
      `select column_name from information_schema.columns where table_name = 'credential_reference'`,
    );
    const names = cols.rows.map((c: { column_name: string }) => c.column_name as string);
    expect(names).toContain("vault_key");
    for (const forbidden of ["secret", "token", "password", "access_token", "api_key", "refresh_token"]) {
      expect(names, `credential_reference must not have a ${forbidden} column`).not.toContain(forbidden);
    }
  });
});

describe("E16: cross-tenant READ is refused as smos_app", () => {
  it("workspace B cannot read workspace A's credential reference", async () => {
    const inserted = await withTenant(pool, a.workspaceId, (tx) => tx.query(
      `insert into credential_reference (id, workspace_id, integration_id, vault_key)
       values (gen_random_uuid(), $1, $2, 'vault://ws-a/meta') returning id`,
      [a.workspaceId, a.integrationId],
    ));
    const credentialId: string = inserted.rows[0].id;

    await withTenant(pool, b.workspaceId, async (tx) => {
      const byId = await tx.query(`select vault_key from credential_reference where id = $1`, [credentialId]);
      expect(byId.rowCount, "plain select by id").toBe(0);

      const explicit = await tx.query(`select vault_key from credential_reference where workspace_id = $1`, [a.workspaceId]);
      expect(explicit.rowCount, "explicit WHERE workspace_id = A").toBe(0);
    });
  });
});

describe("E16: cross-tenant WRITE is refused as smos_app", () => {
  it("refuses a plain INSERT tagged with another workspace (RLS WITH CHECK)", async () => {
    await expect(withTenant(pool, b.workspaceId, (tx) => tx.query(
      `insert into credential_reference (id, workspace_id, integration_id, vault_key)
       values (gen_random_uuid(), $1, $2, 'vault://hijack/plain')`,
      [a.workspaceId, a.integrationId],
    ))).rejects.toThrow(/new row violates row-level security policy for table "credential_reference"/);
  });

  it("refuses a same-workspace-tagged INSERT whose integration_id belongs to another workspace (composite FK, RLS bypassed on the referenced table)", async () => {
    // Tagged workspace_id = B (passes B's own WITH CHECK trivially) but
    // points integration_id at A's integration row. PostgreSQL evaluates FKs
    // against the referenced table with RLS bypassed entirely, so only the
    // composite (integration_id, workspace_id) FK -- not RLS -- can catch this.
    await expect(withTenant(pool, b.workspaceId, (tx) => tx.query(
      `insert into credential_reference (id, workspace_id, integration_id, vault_key)
       values (gen_random_uuid(), $1, $2, 'vault://hijack/fk')`,
      [b.workspaceId, a.integrationId],
    ))).rejects.toThrow(/credential_reference_integration_id_workspace_id_fkey/);
  });

  it("still allows a credential reference pointing at its own workspace's integration", async () => {
    await withTenant(pool, a.workspaceId, (tx) => tx.query(
      `insert into credential_reference (id, workspace_id, integration_id, vault_key)
       values (gen_random_uuid(), $1, $2, 'vault://ws-a/legit')`,
      [a.workspaceId, a.integrationId],
    ));
  });
});

describe("E16: metric rows require freshness and attribution", () => {
  it("refuses a metric missing freshness_at, attribution_model, attribution_window, confidence", async () => {
    await expect(withTenant(pool, a.workspaceId, (tx) => tx.query(
      `insert into metric (id, workspace_id, campaign_id, name, value) values (gen_random_uuid(), $1, $2, 'reach', 100)`,
      [a.workspaceId, a.campaignId],
    ))).rejects.toThrow(/null value|not-null/i);
  });

  it("accepts a metric that states its freshness and attribution in full", async () => {
    await withTenant(pool, a.workspaceId, (tx) => tx.query(
      `insert into metric (id, workspace_id, campaign_id, name, value, freshness_at, attribution_model, attribution_window, confidence)
       values (gen_random_uuid(), $1, $2, 'reach', 100, now(), 'last_touch', '7d', 'medium')`,
      [a.workspaceId, a.campaignId],
    ));
  });

  it("refuses a metric whose campaign_id belongs to another workspace (composite FK)", async () => {
    await expect(withTenant(pool, b.workspaceId, (tx) => tx.query(
      `insert into metric (id, workspace_id, campaign_id, name, value, freshness_at, attribution_model, attribution_window, confidence)
       values (gen_random_uuid(), $1, $2, 'reach', 1, now(), 'last_touch', '7d', 'low')`,
      [b.workspaceId, a.campaignId],
    ))).rejects.toThrow(/metric_campaign_id_workspace_id_fkey/);
  });
});

describe("E16: event tolerates an out-of-order webhook and refuses a cross-workspace publication", () => {
  it("accepts an event with no matching publication yet (publication_id null)", async () => {
    await withTenant(pool, a.workspaceId, (tx) => tx.query(
      `insert into event (id, workspace_id, event_type, occurred_at) values (gen_random_uuid(), $1, 'webhook.received', now())`,
      [a.workspaceId],
    ));
  });

  it("refuses an event whose publication_id belongs to another workspace (composite FK)", async () => {
    await expect(withTenant(pool, b.workspaceId, (tx) => tx.query(
      `insert into event (id, workspace_id, publication_id, event_type, occurred_at)
       values (gen_random_uuid(), $1, $2, 'webhook.received', now())`,
      [b.workspaceId, a.publicationId],
    ))).rejects.toThrow(/event_publication_id_workspace_id_fkey/);
  });

  it("still allows an event pointing at its own workspace's publication", async () => {
    await withTenant(pool, a.workspaceId, (tx) => tx.query(
      `insert into event (id, workspace_id, publication_id, event_type, occurred_at)
       values (gen_random_uuid(), $1, $2, 'webhook.received', now())`,
      [a.workspaceId, a.publicationId],
    ));
  });
});

describe("E16: webhook_delivery records a bad signature rather than dropping it", () => {
  it("stores signature_ok = false as a real row, not a silently discarded delivery", async () => {
    const key = `e16-bad-sig-${Date.now()}-${Math.random()}`;
    await withTenant(pool, a.workspaceId, (tx) => tx.query(
      `insert into webhook_delivery (id, workspace_id, provider, external_id, signature_ok, payload)
       values (gen_random_uuid(), $1, 'meta', $2, false, '{}'::jsonb)`,
      [a.workspaceId, key],
    ));
    const seen = await withTenant(pool, a.workspaceId, (tx) => tx.query(
      `select signature_ok from webhook_delivery where external_id = $1`,
      [key],
    ));
    expect(seen.rowCount).toBe(1);
    expect(seen.rows[0].signature_ok).toBe(false);
  });

  it("refuses two deliveries sharing (workspace_id, provider, external_id)", async () => {
    const key = `e16-dup-${Date.now()}-${Math.random()}`;
    await withTenant(pool, a.workspaceId, (tx) => tx.query(
      `insert into webhook_delivery (id, workspace_id, provider, external_id, signature_ok, payload)
       values (gen_random_uuid(), $1, 'meta', $2, true, '{}'::jsonb)`,
      [a.workspaceId, key],
    ));
    await expect(withTenant(pool, a.workspaceId, (tx) => tx.query(
      `insert into webhook_delivery (id, workspace_id, provider, external_id, signature_ok, payload)
       values (gen_random_uuid(), $1, 'meta', $2, true, '{}'::jsonb)`,
      [a.workspaceId, key],
    ))).rejects.toThrow(/unique|duplicate/i);
  });

  // Late-review CRITICAL 2: the uniqueness above is now a PARTIAL index
  // restricted to verified rows (0032), so that a rejected delivery cannot
  // burn a delivery id a genuine one will later claim. The property this
  // suite pins -- two VERIFIED deliveries cannot share the key -- is
  // unchanged and asserted above; the complementary half is pinned here so
  // dropping either index is loud.
  it("keeps rejected and verified receipts in separate key spaces", async () => {
    const key = `e16-partial-${Date.now()}-${Math.random()}`;
    await withTenant(pool, a.workspaceId, (tx) => tx.query(
      `insert into webhook_delivery (id, workspace_id, provider, external_id, signature_ok, payload)
       values (gen_random_uuid(), $1, 'meta', $2, false, '{}'::jsonb)`,
      [a.workspaceId, key],
    ));
    await withTenant(pool, a.workspaceId, (tx) => tx.query(
      `insert into webhook_delivery (id, workspace_id, provider, external_id, signature_ok, payload)
       values (gen_random_uuid(), $1, 'meta', $2, true, '{}'::jsonb)`,
      [a.workspaceId, key],
    ));
    const r = await adminPool.query(
      `select count(*)::int as n from webhook_delivery where workspace_id = $1 and external_id = $2`,
      [a.workspaceId, key],
    );
    expect(r.rows[0].n).toBe(2);
  });
});

describe("E16: integration.status is constrained to the known lifecycle values", () => {
  it("refuses an unrecognized status", async () => {
    await expect(withTenant(pool, a.workspaceId, (tx) => tx.query(
      `insert into integration (id, workspace_id, provider, status) values (gen_random_uuid(), $1, 'meta_ads', 'made_up_status')`,
      [a.workspaceId],
    ))).rejects.toThrow(/integration_status_check/);
  });

  // Late-review IMPORTANT 3: 'sandbox' is no longer a status that can simply
  // be asserted -- it requires naming a publication that actually succeeded
  // (0033_integration_sandbox_must_be_earned.sql). This test used to insert
  // all four values bare, which is precisely the reviewer's attack written
  // as an expectation. The three claims a row may still make on its own are
  // still accepted here; the fourth now has its own coverage in
  // packages/db/src/integration-verification.test.ts, including the case
  // where it must be refused.
  it("accepts each lifecycle status a row may claim without external evidence", async () => {
    for (const status of ["not_implemented", "disconnected", "connected"]) {
      await withTenant(pool, a.workspaceId, (tx) => tx.query(
        `insert into integration (id, workspace_id, provider, status) values (gen_random_uuid(), $1, $2, $3)`,
        [a.workspaceId, `probe-${status}-${Date.now()}-${Math.random()}`, status],
      ));
    }
  });

  it("refuses 'sandbox' asserted with no verifying publication", async () => {
    await expect(withTenant(pool, a.workspaceId, (tx) => tx.query(
      `insert into integration (id, workspace_id, provider, status) values (gen_random_uuid(), $1, $2, 'sandbox')`,
      [a.workspaceId, `probe-sandbox-${Date.now()}-${Math.random()}`],
    ))).rejects.toThrow(/integration_sandbox_needs_evidence_check/);
  });
});
