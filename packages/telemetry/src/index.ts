import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export { createLogger, logger, type Logger, type LogLevel, type LogSink } from "./logger.ts";
export { redact, REDACTED } from "./redact.ts";
export { withSpan } from "./spans.ts";

export interface TelemetryOptions {
  serviceName: string;
  endpoint?: string | undefined;
}

/**
 * Must run before any instrumented module is imported, otherwise the
 * auto-instrumentation hooks miss them. Returns a shutdown function.
 */
export async function startTelemetry(opts: TelemetryOptions): Promise<() => Promise<void>> {
  // With no endpoint the SDK defaults to an OTLP exporter aimed at
  // http://localhost:4318, so every local run and every CI run would fail on
  // shutdown with ECONNREFUSED. Instrumentation still runs and spans are still
  // created; they simply have nowhere to go until a collector is configured.
  const exportSpans = opts.endpoint !== undefined && opts.endpoint.length > 0;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: opts.serviceName }),
    instrumentations: [getNodeAutoInstrumentations()],
    ...(exportSpans ? {} : { spanProcessors: [] }),
  });
  sdk.start();

  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    await sdk.shutdown();
  };
}
