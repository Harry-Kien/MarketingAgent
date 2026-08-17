import { createEnvKmsProvider, createVaultPool, type KmsProvider } from "@smos/vault";
import type pg from "pg";

// Same "one pool per process, cached on globalThis" pattern as
// server/db.ts, and for the identical reason (Next.js dev mode hot-reloads
// server modules on every save). A SEPARATE pool from getPool(): this one
// connects with DATABASE_VAULT_URL (the smos_vault role), which is the only
// credential that can reach vault_secret at all (0036_vault_secret.sql) --
// getPool()'s DATABASE_URL (smos_app) has zero grants on that table by
// design, so the two pools must never be merged into one.
const globalForVault = globalThis as unknown as { __smosVaultPool?: pg.Pool; __smosKmsProvider?: KmsProvider };

export function getVaultPool(): pg.Pool {
  if (!globalForVault.__smosVaultPool) {
    const url =
      process.env["DATABASE_VAULT_URL"] ?? "postgres://smos_vault:smos_vault_local_dev@127.0.0.1:5433/smos";
    globalForVault.__smosVaultPool = createVaultPool(url);
  }
  return globalForVault.__smosVaultPool;
}

/**
 * The local-development KmsProvider (packages/vault/src/providers/
 * env-kms-provider.ts), read from process.env once per process. Swapping in
 * a real hosted KMS in a later milestone is a one-line change here --
 * nothing else in apps/web imports env-kms-provider.ts directly.
 */
export function getKmsProvider(): KmsProvider {
  if (!globalForVault.__smosKmsProvider) {
    globalForVault.__smosKmsProvider = createEnvKmsProvider();
  }
  return globalForVault.__smosKmsProvider;
}
