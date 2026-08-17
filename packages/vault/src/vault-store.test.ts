// Integration proof against the REAL PostgreSQL on 5433 -- no mocked RLS,
// triggers, constraints, transactions or permissions anywhere in this file.
// Three roles are exercised directly: smos_vault (via withVaultTenant, the
// only role that can touch vault_secret at all), smos_app (attacked
// directly with a raw connection, to prove it has literally nothing), and
// smos (the migration superuser, used only to seed workspaces and to read
// pg_catalog/information_schema, never to make an isolation assertion).
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { newId, type Id } from "@smos/domain";
import { createVaultPool, withVaultTenant } from "./vault-pool.ts";
import { putSecret, resolveSecret, rotateSecretKek } from "./vault-store.ts";
import { buildVaultKey } from "./vault-key.ts";
import { VaultKeyMismatchError, VaultNotFoundError } from "./errors.ts";
import { createFakeKmsProvider } from "./test-helpers/fake-kms-provider.ts";

const vaultUrl =
  process.env["DATABASE_VAULT_URL"] ?? "postgres://smos_vault:smos_vault_local_dev@127.0.0.1:5433/smos";
const appUrl = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";

const vaultPool = createVaultPool(vaultUrl);
const appPool = new pg.Pool({ connectionString: appUrl });
const adminPool = new pg.Pool({ connectionString: adminUrl });

async function createWorkspace(label: string): Promise<Id> {
  const id = newId();
  await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [id, `vault-test-${label}-${id}`]);
  return id as Id;
}

const workspacesToClean: Id[] = [];

afterAll(async () => {
  for (const id of workspacesToClean) {
    await adminPool.query("delete from vault_secret where workspace_id = $1", [id]).catch(() => undefined);
    await adminPool.query("delete from workspace where id = $1", [id]).catch(() => undefined);
  }
  await vaultPool.end();
  await appPool.end();
  await adminPool.end();
});

describe("putSecret / resolveSecret round trip against real PostgreSQL", () => {
  it("stores ciphertext only and resolves back to the original plaintext", async () => {
    const kms = createFakeKmsProvider();
    const workspaceId = await createWorkspace("roundtrip");
    workspacesToClean.push(workspaceId);
    const vaultKey = await putSecret(vaultPool, kms, workspaceId, "meta-webhook-secret", "top-secret-value-123");
    expect(vaultKey).toBe(buildVaultKey(workspaceId, "meta-webhook-secret"));
    const plaintext = await resolveSecret(vaultPool, kms, workspaceId, vaultKey);
    expect(plaintext).toBe("top-secret-value-123");
  });

  it("the stored row's ciphertext column never contains the plaintext bytes", async () => {
    const kms = createFakeKmsProvider();
    const workspaceId = await createWorkspace("no-plaintext-at-rest");
    workspacesToClean.push(workspaceId);
    const secret = "extremely-identifiable-plaintext-marker-xyz";
    await putSecret(vaultPool, kms, workspaceId, "probe", secret);
    const row = await adminPool.query("select ciphertext, wrapped_data_key from vault_secret where workspace_id = $1", [
      workspaceId,
    ]);
    const ciphertextText = (row.rows[0].ciphertext as Buffer).toString("latin1");
    const wrappedText = (row.rows[0].wrapped_data_key as Buffer).toString("latin1");
    expect(ciphertextText).not.toContain(secret);
    expect(wrappedText).not.toContain(secret);
  });

  it("throws VaultNotFoundError for a slug that was never stored", async () => {
    const kms = createFakeKmsProvider();
    const workspaceId = await createWorkspace("missing");
    workspacesToClean.push(workspaceId);
    await expect(
      resolveSecret(vaultPool, kms, workspaceId, buildVaultKey(workspaceId, "never-stored")),
    ).rejects.toThrow(VaultNotFoundError);
  });

  it("refuses to store a second secret under a slug already in use (not a silent overwrite)", async () => {
    const kms = createFakeKmsProvider();
    const workspaceId = await createWorkspace("dup-slug");
    workspacesToClean.push(workspaceId);
    await putSecret(vaultPool, kms, workspaceId, "once", "first-value");
    await expect(putSecret(vaultPool, kms, workspaceId, "once", "second-value")).rejects.toThrow();
  });
});

describe("tenant isolation: resolving workspace A's pointer from workspace B's context fails", () => {
  it("app-layer check (VaultKeyMismatchError) refuses before any query is sent", async () => {
    const kms = createFakeKmsProvider();
    const a = await createWorkspace("iso-a");
    workspacesToClean.push(a);
    const b = await createWorkspace("iso-b");
    workspacesToClean.push(b);
    const vaultKey = await putSecret(vaultPool, kms, a, "secret", "a-only-value");
    await expect(resolveSecret(vaultPool, kms, b, vaultKey)).rejects.toThrow(VaultKeyMismatchError);
  });

  it("database-layer RLS independently keeps two workspaces' rows disjoint under the identical slug", async () => {
    const kms = createFakeKmsProvider();
    const a = await createWorkspace("iso-fk-a");
    workspacesToClean.push(a);
    const b = await createWorkspace("iso-fk-b");
    workspacesToClean.push(b);
    await putSecret(vaultPool, kms, a, "shared-slug-name", "a-value");
    await putSecret(vaultPool, kms, b, "shared-slug-name", "b-value");

    const bPlain = await resolveSecret(vaultPool, kms, b, buildVaultKey(b, "shared-slug-name"));
    expect(bPlain).toBe("b-value");

    await withVaultTenant(vaultPool, b, async (tx) => {
      const leak = await tx.query("select id from vault_secret where workspace_id = $1", [a]);
      expect(leak.rowCount).toBe(0);
      const plainSelect = await tx.query("select id from vault_secret where slug = 'shared-slug-name'");
      expect(plainSelect.rowCount).toBe(1); // only B's own row, never A's
    });
  });

  it("an UPDATE scoped to workspace B cannot touch workspace A's row even with smos_vault's own UPDATE grant", async () => {
    const kms = createFakeKmsProvider();
    const a = await createWorkspace("iso-update-a");
    workspacesToClean.push(a);
    const b = await createWorkspace("iso-update-b");
    workspacesToClean.push(b);
    await putSecret(vaultPool, kms, a, "target", "a-value");

    await withVaultTenant(vaultPool, b, async (tx) => {
      const r = await tx.query("update vault_secret set kek_id = 'hijacked' where slug = 'target'");
      expect(r.rowCount).toBe(0);
    });

    const stillIntact = await adminPool.query("select kek_id from vault_secret where workspace_id = $1", [a]);
    expect(stillIntact.rows[0].kek_id).not.toBe("hijacked");
  });

  it("an error from a mismatched resolveSecret attempt carries no fragment of the secret", async () => {
    const kms = createFakeKmsProvider();
    const a = await createWorkspace("iso-log-a");
    workspacesToClean.push(a);
    const b = await createWorkspace("iso-log-b");
    workspacesToClean.push(b);
    const vaultKey = await putSecret(vaultPool, kms, a, "secret", "a-only-log-marker-value");
    try {
      await resolveSecret(vaultPool, kms, b, vaultKey);
      expect.unreachable("resolveSecret must throw for a cross-workspace vault key");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("a-only-log-marker-value");
    }
  });
});

describe("smos_app cannot reach vault_secret at all -- attacked directly as smos_app, not mocked", () => {
  it("smos_app has zero privileges on vault_secret", async () => {
    const r = await adminPool.query(
      `select privilege_type from information_schema.role_table_grants where table_name = 'vault_secret' and grantee = 'smos_app'`,
    );
    expect(r.rows).toEqual([]);
  });

  it("SELECT as smos_app is refused with permission denied, not an empty RLS-filtered result", async () => {
    const client = await appPool.connect();
    try {
      await expect(client.query("select * from vault_secret")).rejects.toThrow(/permission denied/i);
    } finally {
      client.release();
    }
  });

  it("INSERT as smos_app is refused with permission denied", async () => {
    const client = await appPool.connect();
    try {
      await expect(
        client.query(
          `insert into vault_secret
             (id, workspace_id, slug, ciphertext, iv, auth_tag, wrapped_data_key, wrap_iv, wrap_auth_tag, kek_id)
           values (gen_random_uuid(), gen_random_uuid(), 'x', '\\x00', '\\x00', '\\x00', '\\x00', '\\x00', '\\x00', 'v1')`,
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      client.release();
    }
  });

  it("UPDATE as smos_app is refused with permission denied", async () => {
    const client = await appPool.connect();
    try {
      await expect(client.query("update vault_secret set kek_id = 'v2'")).rejects.toThrow(/permission denied/i);
    } finally {
      client.release();
    }
  });

  it("DELETE as smos_app is refused with permission denied", async () => {
    const client = await appPool.connect();
    try {
      await expect(client.query("delete from vault_secret")).rejects.toThrow(/permission denied/i);
    } finally {
      client.release();
    }
  });

  it("smos_vault itself has exactly SELECT/INSERT/UPDATE -- never DELETE", async () => {
    const r = await adminPool.query(
      `select privilege_type from information_schema.role_table_grants where table_name = 'vault_secret' and grantee = 'smos_vault'`,
    );
    const privileges = (r.rows as { privilege_type: string }[]).map((row) => row.privilege_type).toSorted();
    expect(privileges).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("smos_app and smos_vault are disjoint roles: neither is a member of the other", async () => {
    const r = await adminPool.query(
      `select
         pg_has_role('smos_app', 'smos_vault', 'member') as app_is_vault_member,
         pg_has_role('smos_vault', 'smos_app', 'member') as vault_is_app_member`,
    );
    expect(r.rows[0].app_is_vault_member).toBe(false);
    expect(r.rows[0].vault_is_app_member).toBe(false);
  });
});

describe("rotation: rewraps the data key without re-encrypting the secret", () => {
  it("ciphertext/iv/auth_tag are byte-identical before and after rotation; only the wrap and kek_id change", async () => {
    const kmsV1 = createFakeKmsProvider("rot-v1");
    const workspaceId = await createWorkspace("rotate");
    workspacesToClean.push(workspaceId);
    await putSecret(vaultPool, kmsV1, workspaceId, "rotatable", "rotate-me-please");

    const before = await adminPool.query(
      "select ciphertext, iv, auth_tag, wrapped_data_key, kek_id from vault_secret where workspace_id = $1",
      [workspaceId],
    );

    // A provider that still holds v1's material (to unwrap the existing
    // row) but whose ACTIVE key is now v2 -- exactly the shape rotating a
    // compromised KEK takes in practice: add the new key, keep the old one
    // just long enough to rewrap every row, then retire it.
    const kmsRotating = createFakeKmsProvider("rot-v2");
    kmsRotating.keks.set("rot-v1", kmsV1.keks.get("rot-v1")!);

    const result = await rotateSecretKek(vaultPool, kmsRotating, workspaceId, "rotatable");
    expect(result.oldKekId).toBe("rot-v1");
    expect(result.newKekId).toBe("rot-v2");

    const after = await adminPool.query(
      "select ciphertext, iv, auth_tag, wrapped_data_key, kek_id, rotated_at from vault_secret where workspace_id = $1",
      [workspaceId],
    );
    expect((after.rows[0].ciphertext as Buffer).equals(before.rows[0].ciphertext as Buffer)).toBe(true);
    expect((after.rows[0].iv as Buffer).equals(before.rows[0].iv as Buffer)).toBe(true);
    expect((after.rows[0].auth_tag as Buffer).equals(before.rows[0].auth_tag as Buffer)).toBe(true);
    expect((after.rows[0].wrapped_data_key as Buffer).equals(before.rows[0].wrapped_data_key as Buffer)).toBe(false);
    expect(after.rows[0].kek_id).toBe("rot-v2");
    expect(after.rows[0].rotated_at).not.toBeNull();

    // Still opens correctly, decrypted through the new wrap.
    const plaintext = await resolveSecret(vaultPool, kmsRotating, workspaceId, buildVaultKey(workspaceId, "rotatable"));
    expect(plaintext).toBe("rotate-me-please");
  });

  it("a provider that no longer holds the OLD key cannot open a not-yet-rotated row (proves rotation is what restores access, not a bypass)", async () => {
    const kmsV1 = createFakeKmsProvider("expire-v1");
    const workspaceId = await createWorkspace("rotate-expired");
    workspacesToClean.push(workspaceId);
    await putSecret(vaultPool, kmsV1, workspaceId, "aging", "value-under-old-kek");

    const kmsWithoutV1 = createFakeKmsProvider("expire-v2"); // does NOT hold expire-v1's material
    await expect(
      resolveSecret(vaultPool, kmsWithoutV1, workspaceId, buildVaultKey(workspaceId, "aging")),
    ).rejects.toThrow(VaultNotFoundError);
  });

  it("rotating throws VaultNotFoundError for a slug that does not exist", async () => {
    const kms = createFakeKmsProvider();
    const workspaceId = await createWorkspace("rotate-missing");
    workspacesToClean.push(workspaceId);
    await expect(rotateSecretKek(vaultPool, kms, workspaceId, "does-not-exist")).rejects.toThrow(VaultNotFoundError);
  });
});

describe("database backstop: the rotation-only trigger refuses a direct SQL attempt to change ciphertext, even as smos_vault", () => {
  it("an UPDATE that touches ciphertext is refused", async () => {
    const kms = createFakeKmsProvider();
    const workspaceId = await createWorkspace("trigger-probe");
    workspacesToClean.push(workspaceId);
    await putSecret(vaultPool, kms, workspaceId, "frozen", "must-not-change");
    await expect(
      withVaultTenant(vaultPool, workspaceId, (tx) =>
        tx.query("update vault_secret set ciphertext = '\\x00'::bytea where slug = $1", ["frozen"]),
      ),
    ).rejects.toThrow(/only the wrapped data key/i);
  });

  it("an UPDATE that touches identity columns (id, workspace_id, slug, created_at) is refused", async () => {
    const kms = createFakeKmsProvider();
    const workspaceId = await createWorkspace("trigger-identity");
    workspacesToClean.push(workspaceId);
    await putSecret(vaultPool, kms, workspaceId, "identity-frozen", "value");
    await expect(
      withVaultTenant(vaultPool, workspaceId, (tx) =>
        tx.query("update vault_secret set slug = 'renamed' where slug = $1", ["identity-frozen"]),
      ),
    ).rejects.toThrow(/only the wrapped data key/i);
  });

  it("an UPDATE that touches only the wrap columns is accepted", async () => {
    const kms = createFakeKmsProvider();
    const workspaceId = await createWorkspace("trigger-allow");
    workspacesToClean.push(workspaceId);
    await putSecret(vaultPool, kms, workspaceId, "rewrap-only", "value");
    await withVaultTenant(vaultPool, workspaceId, (tx) =>
      tx.query("update vault_secret set kek_id = 'manual-v9', rotated_at = now() where slug = $1", ["rewrap-only"]),
    );
    const row = await adminPool.query("select kek_id from vault_secret where workspace_id = $1", [workspaceId]);
    expect(row.rows[0].kek_id).toBe("manual-v9");
  });

  it("a row-identical UPDATE (no actual change) is still permitted", async () => {
    const kms = createFakeKmsProvider();
    const workspaceId = await createWorkspace("trigger-noop");
    workspacesToClean.push(workspaceId);
    await putSecret(vaultPool, kms, workspaceId, "noop", "value");
    await withVaultTenant(vaultPool, workspaceId, (tx) =>
      tx.query("update vault_secret set kek_id = kek_id where slug = $1", ["noop"]),
    );
  });
});

describe("RLS is enabled and forced on vault_secret", () => {
  it("relrowsecurity and relforcerowsecurity are both true", async () => {
    const r = await adminPool.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where relname = 'vault_secret'",
    );
    expect(r.rows[0].relrowsecurity).toBe(true);
    expect(r.rows[0].relforcerowsecurity).toBe(true);
  });

  it("its tenant-isolation policy carries both USING and WITH CHECK", async () => {
    const r = await adminPool.query(
      `select qual is not null as has_using, with_check is not null as has_with_check
       from pg_policies where schemaname = 'public' and tablename = 'vault_secret'`,
    );
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows as { has_using: boolean; has_with_check: boolean }[]) {
      expect(row.has_using).toBe(true);
      expect(row.has_with_check).toBe(true);
    }
  });

  it("with app.workspace_id unset entirely, smos_vault reads zero rows rather than everything", async () => {
    const fresh = new pg.Client({ connectionString: vaultUrl });
    await fresh.connect();
    try {
      const r = await fresh.query("select count(*)::int as n from vault_secret");
      expect(r.rows[0].n).toBe(0);
    } finally {
      await fresh.end();
    }
  });
});
