// Adversarial self-review, run for real against PostgreSQL on 5433 -- not
// reasoned about, proven. Four of the five scenarios named in the task
// brief are already covered elsewhere and are not repeated here:
//   - "read another workspace's ciphertext / your own workspace's
//     plaintext as smos_app" -> vault-store.test.ts's "smos_app cannot
//     reach vault_secret at all" describe block (zero grants, proven by
//     direct SELECT/INSERT/UPDATE/DELETE as smos_app).
//   - "make an error path leak key material" -> envelope.test.ts's
//     "VaultTamperError message never contains the plaintext or key
//     bytes" plus this package containing no logging calls at all (grepped
//     -- packages/vault emits nothing; only the caller, apps/web/src/
//     server/webhook-secret.ts, ever logs, and only `error.name`).
// This file covers the two that need their own scenario: substituting one
// workspace's wrapped key for another's, and replaying an old ciphertext
// snapshot after rotation.
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { newId, type Id } from "@smos/domain";
import { createVaultPool, withVaultTenant } from "./vault-pool.ts";
import { openSecret, type SealedSecret } from "./envelope.ts";
import { putSecret, resolveSecret, rotateSecretKek } from "./vault-store.ts";
import { buildVaultKey } from "./vault-key.ts";
import { VaultNotFoundError, VaultTamperError } from "./errors.ts";
import { createFakeKmsProvider } from "./test-helpers/fake-kms-provider.ts";

const vaultUrl =
  process.env["DATABASE_VAULT_URL"] ?? "postgres://smos_vault:smos_vault_local_dev@127.0.0.1:5433/smos";
const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";

const vaultPool = createVaultPool(vaultUrl);
const adminPool = new pg.Pool({ connectionString: adminUrl });

async function createWorkspace(label: string): Promise<Id> {
  const id = newId();
  await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [id, `adversarial-${label}-${id}`]);
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

interface VaultSecretRow {
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  wrapped_data_key: Buffer;
  wrap_iv: Buffer;
  wrap_auth_tag: Buffer;
  kek_id: string;
}

async function readRow(workspaceId: Id, slug: string): Promise<VaultSecretRow> {
  const r = await withVaultTenant(vaultPool, workspaceId, (tx) =>
    tx.query(
      "select ciphertext, iv, auth_tag, wrapped_data_key, wrap_iv, wrap_auth_tag, kek_id from vault_secret where workspace_id = $1 and slug = $2",
      [workspaceId, slug],
    ),
  );
  return r.rows[0] as VaultSecretRow;
}

describe("adversarial: substituting workspace A's wrapped key onto workspace B's row", () => {
  it("does not decrypt B's real secret, and does not leak A's -- it fails loudly (VaultTamperError)", async () => {
    // One shared KMS (same KEK), which is the WORST case for this attack:
    // if the wrapped keys were ever going to be interchangeable, it would
    // be here, where both actually unwrap successfully under the same KEK.
    const kms = createFakeKmsProvider("adversarial-shared-kek");
    const a = await createWorkspace("subst-a");
    workspacesToClean.push(a);
    const b = await createWorkspace("subst-b");
    workspacesToClean.push(b);

    await putSecret(vaultPool, kms, a, "target", "workspace-a-real-secret");
    await putSecret(vaultPool, kms, b, "target", "workspace-b-real-secret");

    const aRow = await readRow(a, "target");

    // Graft A's wrap columns onto B's row. This is exactly the set of
    // columns 0036_vault_secret.sql's rotation-only trigger permits an
    // UPDATE to touch (by design, so real rotation can happen at all) --
    // proving this attack fails even through the ONE legitimate write path
    // is the whole point, not a strawman restricted to a hypothetical wider
    // UPDATE the trigger already blocks (that's proven separately in
    // vault-store.test.ts's own trigger describe block).
    await withVaultTenant(vaultPool, b, (tx) =>
      tx.query(
        `update vault_secret set wrapped_data_key = $1, wrap_iv = $2, wrap_auth_tag = $3, kek_id = $4
         where workspace_id = $5 and slug = $6`,
        [aRow.wrapped_data_key, aRow.wrap_iv, aRow.wrap_auth_tag, aRow.kek_id, b, "target"],
      ),
    );

    // A's DEK now unwraps successfully (same KEK) -- but B's ciphertext was
    // never encrypted under A's DEK, so AES-256-GCM's own authentication
    // tag refuses to decrypt it, with no need for any application-level
    // "does this key belong to this row" check: wrong key is caught by the
    // same mechanism that catches tampered bytes.
    await expect(resolveSecret(vaultPool, kms, b, buildVaultKey(b, "target"))).rejects.toThrow(VaultTamperError);

    // And critically: A's own secret is completely unaffected (A's row was
    // never written to).
    expect(await resolveSecret(vaultPool, kms, a, buildVaultKey(a, "target"))).toBe("workspace-a-real-secret");
  });
});

describe("adversarial: replaying a ciphertext snapshot captured before rotation", () => {
  it("an old snapshot still decrypts if the OLD KEK material still exists -- rotation of the ROW does not retroactively invalidate a copy taken before it", async () => {
    const kmsV1 = createFakeKmsProvider("replay-v1");
    const workspaceId = await createWorkspace("replay-still-live");
    workspacesToClean.push(workspaceId);
    await putSecret(vaultPool, kmsV1, workspaceId, "rotatable", "pre-rotation-secret-value");

    // The attacker's captured snapshot: everything needed to reconstruct
    // a SealedSecret, taken BEFORE rotation.
    const before = await readRow(workspaceId, "rotatable");
    const capturedSnapshot: SealedSecret = {
      ciphertext: before.ciphertext,
      iv: before.iv,
      authTag: before.auth_tag,
      wrappedKey: { kekId: before.kek_id, ciphertext: before.wrapped_data_key, iv: before.wrap_iv, authTag: before.wrap_auth_tag },
    };

    const kmsRotating = createFakeKmsProvider("replay-v2");
    kmsRotating.keks.set("replay-v1", kmsV1.keks.get("replay-v1")!); // still holds the old key -- not yet retired
    await rotateSecretKek(vaultPool, kmsRotating, workspaceId, "rotatable");

    // Ciphertext never changes across rotation (proven separately in
    // vault-store.test.ts), so the OLD snapshot -- reconstructed entirely
    // from bytes captured before the rotation ran, touching the database
    // not at all -- still opens correctly as long as SOMETHING still holds
    // "replay-v1"'s key material. This is the honest limit of "rotation":
    // it makes retiring the compromised KEK SAFE (no live row depends on
    // it anymore), it does not, by itself, retroactively revoke a snapshot
    // an attacker already exfiltrated.
    const stillOpens = await openSecret(capturedSnapshot, kmsRotating);
    expect(stillOpens).toBe("pre-rotation-secret-value");
  });

  it("...and is exactly what retiring the OLD KEK from the provider closes", async () => {
    const kmsV1 = createFakeKmsProvider("retire-v1");
    const workspaceId = await createWorkspace("replay-retired");
    workspacesToClean.push(workspaceId);
    await putSecret(vaultPool, kmsV1, workspaceId, "rotatable", "pre-rotation-secret-value-2");

    const before = await readRow(workspaceId, "rotatable");
    const capturedSnapshot: SealedSecret = {
      ciphertext: before.ciphertext,
      iv: before.iv,
      authTag: before.auth_tag,
      wrappedKey: { kekId: before.kek_id, ciphertext: before.wrapped_data_key, iv: before.wrap_iv, authTag: before.wrap_auth_tag },
    };

    const kmsRotating = createFakeKmsProvider("retire-v2");
    kmsRotating.keks.set("retire-v1", kmsV1.keks.get("retire-v1")!);
    await rotateSecretKek(vaultPool, kmsRotating, workspaceId, "rotatable");

    // Retire the old KEK: same active key material as `kmsRotating`
    // actually wrapped the rotated row under (NOT a fresh
    // createFakeKmsProvider("retire-v2") -- the fake provider generates
    // random key bytes per construction, so a second call with the same
    // label would hold DIFFERENT bytes and this test would fail for the
    // wrong reason). This is the local-dev equivalent of deleting
    // VAULT_KEK_RETIRE_V1 from the environment once every row wrapped
    // under it has been rotated -- keep every OTHER key, drop only the
    // retired one.
    const kmsAfterRetirement = createFakeKmsProvider("retire-v2");
    kmsAfterRetirement.keks.set("retire-v2", kmsRotating.keks.get("retire-v2")!);
    // Deliberately does NOT hold "retire-v1" -- this is the point.

    await expect(openSecret(capturedSnapshot, kmsAfterRetirement)).rejects.toThrow(VaultNotFoundError);

    // The CURRENT row (post-rotation) is completely unaffected: it was
    // rewrapped under retire-v2, which the post-retirement provider still
    // holds.
    const current = await resolveSecret(vaultPool, kmsAfterRetirement, workspaceId, buildVaultKey(workspaceId, "rotatable"));
    expect(current).toBe("pre-rotation-secret-value-2");
  });
});
