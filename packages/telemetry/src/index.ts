import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export { createLogger, logger, type Logger, type LogLevel, type LogSink } from "./logger.js";
export { redact, REDACTED } from "./redact.js";

export interface TelemetryOptions {
  serviceName: string;
  endpoint?: string | undefined;
}

/**
 * Must run before any instrumented module is imported, otherwise the
 * auto-instrumentation hooks miss them. Returns a shutdown function.
 */
export async function startTelemetry(opts: TelemetryOptions): Promise<() => Promise<void>> {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: opts.serviceName }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
  return () => sdk.shutdown();
}
