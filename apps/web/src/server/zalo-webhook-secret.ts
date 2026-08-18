import type { Id } from "@smos/domain";
import { getOrCreateSecret } from "@smos/vault";
import { logger } from "@smos/telemetry";
import { getKmsProvider, getVaultPool } from "./vault.ts";

// Fixed slug, mirroring webhook-secret.ts's own WEBHOOK_SECRET_SLUG: one
// Zalo-webhook-signing secret per workspace, provisioned once on first use
// and stored sealed via the credential vault (0036_vault_secret.sql). A
// SEPARATE secret from Meta's (different slug) -- leaking one channel's
// webhook secret must never say anything about the other's.
const ZALO_WEBHOOK_SECRET_SLUG = "zalo-webhook-secret";

/**
 * Never throws. Any failure (vault unreachable, workspace id not a real
 * row) resolves to `null`, and the caller (route.ts) treats a null secret
 * exactly like a bad signature: 401, never a 500, never "skip
 * verification" -- the identical contract getWorkspaceWebhookSecret (Meta)
 * already uses.
 */
export async function getWorkspaceZaloWebhookSecret(workspaceId: Id): Promise<string | null> {
  try {
    return await getOrCreateSecret(getVaultPool(), getKmsProvider(), workspaceId, ZALO_WEBHOOK_SECRET_SLUG);
  } catch (error) {
    logger.warn("could not resolve or provision this workspace's Zalo webhook secret from the vault", {
      workspaceId,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}
