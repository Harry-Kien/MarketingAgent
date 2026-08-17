import type pg from "pg";
import { newId, type Id } from "@smos/domain";
import { openSecret, sealSecret } from "./envelope.ts";
import type { KmsProvider, WrappedKey } from "./kms-provider.ts";
import { buildVaultKey, parseVaultKey } from "./vault-key.ts";
import { withVaultTenant } from "./vault-pool.ts";
import { VaultKeyMismatchError, VaultNotFoundError } from "./errors.ts";

interface VaultSecretRow {
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  wrapped_data_key: Buffer;
  wrap_iv: Buffer;
  wrap_auth_tag: Buffer;
  kek_id: string;
}

function rowToWrappedKey(row: VaultSecretRow): WrappedKey {
  return { kekId: row.kek_id, ciphertext: row.wrapped_data_key, iv: row.wrap_iv, authTag: row.wrap_auth_tag };
}

/**
 * Encrypts `plaintext` (sealSecret) and inserts one new row, scoped to
 * `workspaceId` via withVaultTenant so RLS's WITH CHECK is a second,
 * independent proof (beyond this function simply passing the right value)
 * that the row lands in the right tenant. Returns the pointer
 * (credential_reference.vault_key's exact format) the caller stores
 * wherever it needs to remember which secret this is.
 *
 * Deliberately a plain INSERT, never an upsert: a slug already in use for
 * this workspace is refused (UNIQUE (workspace_id, slug)) rather than
 * silently overwritten -- replacing a secret's actual VALUE (e.g. a
 * refreshed OAuth token) is a different, not-yet-built operation from
 * rotating which KEK protects it (rotateSecretKek, below); this milestone
 * only needs the latter (moving the webhook root secret onto this layer,
 * which is written once per workspace and never changes).
 */
export async function putSecret(
  vaultPool: pg.Pool,
  kms: KmsProvider,
  workspaceId: Id,
  slug: string,
  plaintext: string,
): Promise<string> {
  const sealed = await sealSecret(plaintext, kms);
  await withVaultTenant(vaultPool, workspaceId, (tx) =>
    tx.query(
      `insert into vault_secret
         (id, workspace_id, slug, ciphertext, iv, auth_tag, wrapped_data_key, wrap_iv, wrap_auth_tag, kek_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        newId(),
        workspaceId,
        slug,
        sealed.ciphertext,
        sealed.iv,
        sealed.authTag,
        sealed.wrappedKey.ciphertext,
        sealed.wrappedKey.iv,
        sealed.wrappedKey.authTag,
        sealed.wrappedKey.kekId,
      ],
    ),
  );
  return buildVaultKey(workspaceId, slug);
}

/**
 * Resolves a vault_key pointer back to its plaintext. Two independent
 * refusals guard cross-tenant resolution, deliberately not just one:
 *
 *  1. App layer: the pointer's OWN workspace segment (parseVaultKey) must
 *     equal `workspaceId`, the tenant context the caller is asking under.
 *     A mismatch throws VaultKeyMismatchError before any query is sent.
 *  2. Database layer: even if (1) were skipped or buggy, withVaultTenant
 *     scopes the session to `workspaceId` via RLS, so a row belonging to a
 *     different workspace is invisible regardless of what slug is asked
 *     for -- proven directly in vault-store.test.ts, not assumed.
 *
 * This is E16's own requirement (design doc, Slice 1 evidence table):
 * "resolve CredentialReference của workspace A từ context của B ⇒ fail;
 * log của lần fail đó không chứa bất kỳ phần nào của secret" -- neither
 * error path below ever includes the plaintext, the data key or the KEK.
 */
export async function resolveSecret(
  vaultPool: pg.Pool,
  kms: KmsProvider,
  workspaceId: Id,
  vaultKey: string,
): Promise<string> {
  const parsed = parseVaultKey(vaultKey);
  if (parsed.workspaceId !== workspaceId) {
    throw new VaultKeyMismatchError(
      `Refusing to resolve a vault key for a different workspace than the caller's own tenant scope`,
    );
  }

  const row = await withVaultTenant(vaultPool, workspaceId, (tx) =>
    tx.query(
      `select ciphertext, iv, auth_tag, wrapped_data_key, wrap_iv, wrap_auth_tag, kek_id
       from vault_secret where workspace_id = $1 and slug = $2`,
      [workspaceId, parsed.slug],
    ),
  );
  const record = row.rows[0] as VaultSecretRow | undefined;
  if (!record) {
    throw new VaultNotFoundError(`No secret stored for "${vaultKey}"`);
  }

  return openSecret(
    {
      ciphertext: record.ciphertext,
      iv: record.iv,
      authTag: record.auth_tag,
      wrappedKey: rowToWrappedKey(record),
    },
    kms,
  );
}

/**
 * Re-wraps a secret's data key under `kms`'s current active KEK version,
 * without ever touching (or needing) the secret's plaintext or its
 * ciphertext/iv/auth_tag columns -- the whole point of envelope encryption:
 * `kms` must still hold the OLD kek_id's key material (to unwrap) as well as
 * the new active one (to re-wrap), exactly the window a real rotation
 * operates in -- add the new KEK, rewrap every row, then retire the old
 * one. vault_secret's own BEFORE UPDATE trigger
 * (0036_vault_secret.sql's vault_secret_rotation_only) is the database
 * backstop that makes it structurally impossible for this function (or
 * anything else running as smos_vault) to smuggle a ciphertext change
 * through what is supposed to be a rewrap-only UPDATE.
 */
export async function rotateSecretKek(
  vaultPool: pg.Pool,
  kms: KmsProvider,
  workspaceId: Id,
  slug: string,
): Promise<{ oldKekId: string; newKekId: string }> {
  return withVaultTenant(vaultPool, workspaceId, async (tx) => {
    const existing = await tx.query(
      `select wrapped_data_key, wrap_iv, wrap_auth_tag, kek_id
       from vault_secret where workspace_id = $1 and slug = $2 for update`,
      [workspaceId, slug],
    );
    const record = existing.rows[0] as VaultSecretRow | undefined;
    if (!record) {
      throw new VaultNotFoundError(`No secret stored for workspace "${workspaceId}" slug "${slug}" to rotate`);
    }

    const oldWrapped = rowToWrappedKey(record);
    const dataKey = await kms.unwrapDataKey(oldWrapped);
    try {
      const newWrapped = await kms.wrapDataKey(dataKey);
      await tx.query(
        `update vault_secret
         set wrapped_data_key = $1, wrap_iv = $2, wrap_auth_tag = $3, kek_id = $4, rotated_at = now()
         where workspace_id = $5 and slug = $6`,
        [newWrapped.ciphertext, newWrapped.iv, newWrapped.authTag, newWrapped.kekId, workspaceId, slug],
      );
      return { oldKekId: oldWrapped.kekId, newKekId: newWrapped.kekId };
    } finally {
      dataKey.fill(0);
    }
  });
}
