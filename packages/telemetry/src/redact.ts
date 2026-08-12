// Broad, deliberately blunt substring match -- this is the fail-closed base
// rule (fix round 2). A round-1 attempt replaced the "token" arm with a
// word-boundary-aware rule meant to spare count fields like `tokensIn`, but
// that rule only recognized word boundaries at camelCase transitions, `_`,
// or `-`. An all-lowercase concatenated key like `accesstoken` or
// `authtoken` produces no boundary at all, so it silently slipped through
// unredacted -- a live secret leak, worse than the over-redaction it was
// meant to fix. Substring matching here is intentionally over-inclusive: of
// the two failure directions, losing a token *count* from telemetry is
// recoverable (it's just missing a number in a log line); leaking a secret
// into a log is not.
const SENSITIVE_KEY = /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential)/i;
const CONNECTION_STRING_PASSWORD = /(:\/\/[^:/@]+:)([^@]+)(@)/g;

// The ONLY exemptions from SENSITIVE_KEY. Each entry here is a deliberate,
// reviewable decision that a specific field name is known to hold a count,
// not a credential -- never a heuristic. A key must match one of these
// tightly anchored patterns *exactly* (start to end) to be spared; nothing
// resembling "contains a count-shaped word" is accepted, because a loose
// version of that idea is exactly what let secrets through in round 1.
//
// Anything not on this list defaults to redacted, including names nobody
// has thought about yet (e.g. `webhookToken`, `sometokenvalue`) and plural
// or array-shaped names that could hold real token values (e.g. `tokens`,
// `apiTokens`, `refreshTokens`).
//
// Only the "token" family has a demonstrated legitimate non-secret sense in
// this codebase today (@smos/model-gateway logs `tokensIn`/`tokensOut`).
// None of password/secret/api-key/authorization/cookie/credential have a
// known analogous case, so no exemptions were added for them -- widening
// the allowlist beyond what's actually needed is how this bug reappears.
const EXEMPT_KEY_PATTERNS: readonly RegExp[] = [/^tokens?[_]?(in|out|count|used|total)$/i];

function isSensitiveKey(key: string): boolean {
  if (EXEMPT_KEY_PATTERNS.some((pattern) => pattern.test(key))) return false;
  return SENSITIVE_KEY.test(key);
}

export const REDACTED = "[redacted]";

/**
 * Remove secret-looking values before anything reaches a log sink or a
 * telemetry exporter (threat T4). Structure is preserved so logs stay
 * readable; only values are replaced.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return value.replace(CONNECTION_STRING_PASSWORD, `$1${REDACTED}$3`);
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(item, seen);
  }
  return out;
}
