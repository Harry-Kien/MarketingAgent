import type { Id } from "@smos/domain";
import { getOrCreateSecret } from "@smos/vault";
import { logger } from "@smos/telemetry";
import { getKmsProvider, getVaultPool } from "./vault.ts";

// Fixed slug: one webhook-signing secret per workspace, provisioned once
// on first use and reused forever after (this milestone never rotates a
// webhook secret's VALUE, only KEK version rotation is implemented --
// packages/vault/src/vault-store.ts's rotateSecretKek).
const WEBHOOK_SECRET_SLUG = "meta-webhook-secret";

/**
 * Replaces the old `deriveWorkspaceSecret(rootSecret, workspaceId)` HMAC
 * derivation (removed from webhook-signature.ts): instead of every
 * workspace's signing secret being a deterministic function of one
 * fleet-wide root -- so leaking that root compromised every tenant at once
 * -- each workspace now gets its own independently-random 256-bit secret,
 * generated on first use and stored sealed via the credential vault
 * (0036_vault_secret.sql). Leaking one workspace's secret says nothing
 * about any other workspace's.
 *
 * Never throws. Any failure (vault unreachable, workspace id not yet a
 * real row -- vault_secret.workspace_id is a real FK, so provisioning a
 * secret for a workspace that does not exist fails there, exactly the
 * "ghost workspace" case route.ts itself used to fail differently for --
 * see route.test.ts's "answers 401, not 404" test and its own comment for
 * why that specific change is deliberate) resolves to `null`, and the
 * caller (route.ts) treats a null secret exactly like a bad signature:
 * 401, never a 500, and never a "skip verification" fallback. The reason
 * is logged with a safe, structured field only (`error.name`) -- never the
 * raw driver error, which for a Postgres constraint violation can include
 * the constraint name and (T4) must never reach a log line unfiltered.
 */
export async function getWorkspaceWebhookSecret(workspaceId: Id): Promise<string | null> {
  try {
    return await getOrCreateSecret(getVaultPool(), getKmsProvider(), workspaceId, WEBHOOK_SECRET_SLUG);
  } catch (error) {
    logger.warn("could not resolve or provision this workspace's webhook secret from the vault", {
      workspaceId,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}
