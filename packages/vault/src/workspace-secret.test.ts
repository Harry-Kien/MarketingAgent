// Integration test against real PostgreSQL: the get-or-create convenience
// used by apps/web's webhook route (server/webhook-secret.ts) to give every
// workspace its own independently-generated signing secret, replacing the
// old single fleet-wide root secret HMAC derivation.
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { newId, type Id } from "@smos/domain";
import { createVaultPool } from "./vault-pool.ts";
import { getOrCreateSecret } from "./workspace-secret.ts";
import { createFakeKmsProvider } from "./test-helpers/fake-kms-provider.ts";

const vaultUrl =
  process.env["DATABASE_VAULT_URL"] ?? "postgres://smos_vault:smos_vault_local_dev@127.0.0.1:5433/smos";
const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";

const vaultPool = createVaultPool(vaultUrl);
const adminPool = new pg.Pool({ connectionString: adminUrl });

async function createWorkspace(label: string): Promise<Id> {
  const id = newId();
  await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [id, `wssecret-${label}-${id}`]);
  return id as Id;
}

const workspacesToClean: Id[] = [];
afterAll(async () => {
  for (const id of workspacesToClean) {
    await adminPool.query("delete from vault_secret where workspace_id = $1", [id]).catch(() => undefined);
    await adminPool.query("delete from workspace where id = $1", [id]).catch(() => undefined);
  }
  await vaultPool.end();
  await adminPool.end();
});

describe("getOrCreateSecret", () => {
  it("generates a secret on first call and returns the SAME secret on every later call", async () => {
    const kms = createFakeKmsProvider();
    const workspaceId = await createWorkspace("first-use");
    workspacesToClean.push(workspaceId);

    const first = await getOrCreateSecret(vaultPool, kms, workspaceId, "meta-webhook-secret");
    const second = await getOrCreateSecret(vaultPool, kms, workspaceId, "meta-webhook-secret");
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(32);
  });

  it("two different workspaces never share the same generated secret", async () => {
    const kms = createFakeKmsProvider();
    const a = await createWorkspace("distinct-a");
    workspacesToClean.push(a);
    const b = await createWorkspace("distinct-b");
    workspacesToClean.push(b);

    const secretA = await getOrCreateSecret(vaultPool, kms, a, "meta-webhook-secret");
    const secretB = await getOrCreateSecret(vaultPool, kms, b, "meta-webhook-secret");
    expect(secretA).not.toBe(secretB);
  });

  it("survives a concurrent first-use race: two simultaneous calls converge on one stored secret", async () => {
    const kms = createFakeKmsProvider();
    const workspaceId = await createWorkspace("race");
    workspacesToClean.push(workspaceId);

    const [a, b] = await Promise.all([
      getOrCreateSecret(vaultPool, kms, workspaceId, "meta-webhook-secret"),
      getOrCreateSecret(vaultPool, kms, workspaceId, "meta-webhook-secret"),
    ]);
    expect(a).toBe(b);

    const rows = await adminPool.query("select count(*)::int as n from vault_secret where workspace_id = $1", [
      workspaceId,
    ]);
    expect(rows.rows[0].n).toBe(1); // never two rows for the same race
  });

  it("uses a caller-supplied generator when provided", async () => {
    const kms = createFakeKmsProvider();
    const workspaceId = await createWorkspace("custom-gen");
    workspacesToClean.push(workspaceId);
    const secret = await getOrCreateSecret(vaultPool, kms, workspaceId, "custom", () => "fixed-test-value");
    expect(secret).toBe("fixed-test-value");
  });
});
