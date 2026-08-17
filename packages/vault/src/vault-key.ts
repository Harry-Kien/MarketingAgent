import { isId, type Id } from "@smos/domain";
import { VaultKeyMismatchError } from "./errors.ts";

const VAULT_KEY_RE = /^vault:\/\/([^/]+)\/([^/]+)$/;

/**
 * credential_reference.vault_key's format, exactly as 0028_integration.sql's
 * header describes it: "vault://<workspace>/<slug>". Here <workspace> is
 * the literal workspace id (a real Id, not a human label) -- so a pointer
 * names the tenant it belongs to by construction, and resolveSecret
 * (vault-store.ts) can refuse a pointer that disagrees with the tenant
 * scope it is being resolved under BEFORE the database's own RLS policy
 * ever gets a chance to. Both checks are real and independent, the same
 * "two mechanisms" shape as every other tenant-isolation control in this
 * codebase.
 */
export interface VaultKey {
  readonly workspaceId: Id;
  readonly slug: string;
}

export function buildVaultKey(workspaceId: Id, slug: string): string {
  return `vault://${workspaceId}/${slug}`;
}

export function parseVaultKey(raw: string): VaultKey {
  const match = VAULT_KEY_RE.exec(raw);
  if (!match) {
    throw new VaultKeyMismatchError(`Malformed vault key (expected "vault://<workspaceId>/<slug>"): "${raw}"`);
  }
  const [, rawWorkspaceId, rawSlug] = match;
  if (!isId(rawWorkspaceId)) {
    throw new VaultKeyMismatchError(`Malformed vault key: "${rawWorkspaceId}" is not a valid workspace id`);
  }
  if (!/\S/.test(rawSlug ?? "")) {
    throw new VaultKeyMismatchError(`Malformed vault key: slug must not be blank`);
  }
  return { workspaceId: rawWorkspaceId as Id, slug: rawSlug! };
}
