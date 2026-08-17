import { DomainError } from "@smos/domain";

/**
 * Thrown when a sealed secret's ciphertext, iv or auth tag has been altered
 * (or the wrong data key/KEK is used to open it). AES-256-GCM's auth tag
 * makes tampering and key-mismatch both surface as one failure -- the
 * message never includes any of the bytes involved (T4: never leak key
 * material or plaintext into an error path).
 */
export class VaultTamperError extends DomainError {
  readonly code = "VAULT_TAMPER";
}

/**
 * Thrown by resolveSecret when no row matches the given vault key, and by
 * the KMS provider when asked to unwrap a data key under a kek_id it does
 * not hold (e.g. a retired KEK version whose env var was removed too early).
 */
export class VaultNotFoundError extends DomainError {
  readonly code = "VAULT_NOT_FOUND";
}

/**
 * Thrown when a vault_key pointer ("vault://<workspaceId>/<slug>") is
 * malformed, or names a workspace other than the one the caller is
 * currently scoped to -- the in-process half of the defence whose database
 * half is vault_secret's RLS policy (0036_vault_secret.sql). Both must
 * refuse independently; this is the app-layer one.
 */
export class VaultKeyMismatchError extends DomainError {
  readonly code = "VAULT_KEY_MISMATCH";
}
