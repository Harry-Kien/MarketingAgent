const SENSITIVE_KEY = /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential)/i;
const CONNECTION_STRING_PASSWORD = /(:\/\/[^:/@]+:)([^@]+)(@)/g;

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
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(item, seen);
  }
  return out;
}
