import { redact } from "@smos/telemetry";

/**
 * Six kinds an operator must be able to tell apart when a publish attempt
 * fails: whether to reconnect, back off, fix input, wait for quota, retry
 * later, or stop entirely.
 */
export const ERROR_KINDS = [
  "auth_expired",
  "rate_limited",
  "invalid_input",
  "quota_exceeded",
  "upstream_unavailable",
  "permanent_rejection",
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

const RETRYABLE: ReadonlySet<ErrorKind> = new Set(["rate_limited", "upstream_unavailable"]);

export function isRetryable(kind: ErrorKind): boolean {
  return RETRYABLE.has(kind);
}

// Token-shaped substrings that can appear in a raw provider error message
// (e.g. Meta's Graph API sometimes echoes the access token back in an error
// body). `redact()` only masks values under sensitive *keys* in structured
// data -- a bare string like this message has no keys -- so a second,
// pattern-based pass is needed to keep a live token out of logs (threat T4).
const TOKEN_SHAPED = /\b(EAA|sk-|ghp_)[A-Za-z0-9_-]+/g;

export class AdapterError extends Error {
  readonly kind: ErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  /** Safe to log or show to an operator. The raw `message` may embed a token. */
  readonly safeMessage: string;

  constructor(kind: ErrorKind, message: string, opts: { retryAfterMs?: number } = {}) {
    super(message);
    this.name = "AdapterError";
    this.kind = kind;
    this.retryable = isRetryable(kind);
    this.retryAfterMs = opts.retryAfterMs;
    this.safeMessage = String(redact(message)).replace(TOKEN_SHAPED, "[redacted]");
  }
}
