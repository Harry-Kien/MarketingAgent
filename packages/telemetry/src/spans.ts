import { SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";
import { redact } from "./redact.ts";

const TRACER_NAME = "smos";

/**
 * Task 6 -- manual spans for the two places P4's Golden Sequence needs
 * explicit, attributed tracing beyond what the HTTP/pg auto-instrumentation
 * (`startTelemetry`, `index.ts`) already gives for free: an agent run
 * (`agent.run`) and an outbound adapter call (`adapter.publish`).
 *
 * `attrs` is redacted (T4, same `redact()` P2's logger already uses) before
 * a single value reaches `span.setAttributes` -- a caller that accidentally
 * passes a raw token or secret-shaped field name (e.g. `{ token: "EAA..." }`)
 * gets `"[redacted]"` on the exported span, never the real value. This
 * matters because span attributes are exported to whatever OTLP collector
 * `startTelemetry` is pointed at -- a third system, outside this
 * application's own log redaction path -- so this is a second, independent
 * place the same secret could otherwise leak from.
 *
 * `fn` always runs; the span always ends via `finally`, whether `fn`
 * resolves, rejects with an `Error`, or rejects with a non-Error thrown
 * value (a span never leaks past the call that opened it, and a broken
 * `fn` never breaks tracing itself). On any rejection the span status is
 * set to ERROR and, for a real `Error`, `recordException` attaches it --
 * then the original rejection is rethrown unchanged so callers see exactly
 * what `fn` threw.
 */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const safeAttrs = redact(attrs) as Attributes;
      span.setAttributes(safeAttrs);
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof Error) {
        span.recordException(err);
      }
      throw err;
    } finally {
      span.end();
    }
  });
}
