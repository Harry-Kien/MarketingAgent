// "token" is handled separately by isSensitiveKey below, because unlike the
// other patterns here it has a legitimate non-secret sense (a count of
// tokens), and a plain substring match redacts that sense too.
const SENSITIVE_KEY = /(pass(word)?|secret|api[-_]?key|authorization|cookie|credential)/i;
const CONNECTION_STRING_PASSWORD = /(:\/\/[^:/@]+:)([^@]+)(@)/g;

// Words that, immediately after a leading "token"/"tokens" segment, mark a
// key as count-shaped (tokensIn, tokenCount, ...) rather than secret-shaped.
const TOKEN_COUNT_SUFFIXES = new Set([
  "in",
  "out",
  "count",
  "used",
  "consumed",
  "remaining",
  "total",
  "limit",
  "budget",
  "spent",
  "size",
]);

export const REDACTED = "[redacted]";

/** Splits a camelCase/snake_case/kebab-case key into lowercase words. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

/**
 * A key is secret-shaped if it matches one of the unconditionally sensitive
 * patterns, or if it contains "token"/"tokens" anywhere except as a leading
 * word immediately followed by exactly one recognized count suffix.
 *
 * This lets `tokensIn`, `tokensOut`, `tokenCount`, `tokensUsed` (and their
 * snake_case equivalents) through untouched, while still catching
 * `sessionToken`, `apiToken`, `accessToken`, `refreshTokens` (token/tokens
 * is not the leading word there) and a bare `tokens` field with no
 * qualifying suffix (which may genuinely hold token *values*, e.g. an
 * array of tokens) -- the default for anything ambiguous is to redact.
 */
function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEY.test(key)) return true;

  const words = keyWords(key);
  const tokenIndex = words.findIndex((w) => w === "token" || w === "tokens");
  if (tokenIndex === -1) return false;

  const suffix = words[1];
  const isCountShaped = tokenIndex === 0 && words.length === 2 && suffix !== undefined && TOKEN_COUNT_SUFFIXES.has(suffix);
  return !isCountShaped;
}

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
