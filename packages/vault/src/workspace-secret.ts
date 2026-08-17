import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { Id } from "@smos/domain";
import type { KmsProvider } from "./kms-provider.ts";
import { buildVaultKey } from "./vault-key.ts";
import { putSecret, resolveSecret } from "./vault-store.ts";
import { VaultNotFoundError } from "./errors.ts";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "23505";
}

/**
 * Get-or-create a per-workspace secret under `slug`, generating one on
 * first use. This is what replaces the webhook root secret's HMAC
 * derivation (apps/web/src/server/webhook-secret.ts): instead of every
 * workspace's signing secret being a deterministic function of one
 * fleet-wide root, each workspace gets its own independently-random secret,
 * generated once and stored sealed -- leaking one workspace's secret no
 * longer says anything at all about any other workspace's.
 *
 * Race handling: two concurrent first-uses (e.g. two requests racing to
 * provision the same workspace's webhook secret) both attempt putSecret;
 * the loser hits vault_secret's UNIQUE (workspace_id, slug) constraint
 * (23505) and re-resolves the winner's row instead of erroring, so both
 * callers converge on the SAME secret rather than one of them getting a
 * value nothing else agrees is correct.
 */
export async function getOrCreateSecret(
  vaultPool: pg.Pool,
  kms: KmsProvider,
  workspaceId: Id,
  slug: string,
  generate: () => string = () => randomBytes(32).toString("hex"),
): Promise<string> {
  const vaultKey = buildVaultKey(workspaceId, slug);
  try {
    return await resolveSecret(vaultPool, kms, workspaceId, vaultKey);
  } catch (error) {
    if (!(error instanceof VaultNotFoundError)) throw error;
  }

  const plaintext = generate();
  try {
    await putSecret(vaultPool, kms, workspaceId, slug, plaintext);
    return plaintext;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return resolveSecret(vaultPool, kms, workspaceId, vaultKey);
    }
    throw error;
  }
}
