import type pg from "pg";
import { withTenant } from "@smos/db";
import type { Id } from "@smos/domain";
import { ALL_KNOWN_PROVIDERS, defaultStatusFor, type IntegrationRow } from "./status.ts";

interface RawIntegrationRow {
  provider: string;
  status: string;
}

/**
 * Every provider in ALL_KNOWN_PROVIDERS, honestly: a real `integration` row
 * if one exists for this workspace, or the truthful default (`disconnected`
 * for an implemented provider with no row yet, `not_implemented` for one
 * with no adapter at all) when it does not. The Integrations page must list
 * TikTok/LinkedIn/Zalo/YouTube even though this workspace has never touched
 * them (Global Constraint #13's other half: an unimplemented provider is
 * shown truthfully, never hidden).
 */
export async function getIntegrationOverview(pool: pg.Pool, workspaceId: Id): Promise<IntegrationRow[]> {
  const result = await withTenant(pool, workspaceId, (tx) =>
    tx.query(`select provider, status from integration where workspace_id = $1`, [workspaceId]),
  );
  const byProvider = new Map<string, string>();
  for (const row of result.rows as RawIntegrationRow[]) {
    byProvider.set(row.provider, row.status);
  }
  return ALL_KNOWN_PROVIDERS.map((provider) => ({
    provider,
    status: (byProvider.get(provider) ?? defaultStatusFor(provider)) as IntegrationRow["status"],
  }));
}
