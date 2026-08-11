/**
 * Next calls register() once per server process, before request handling.
 * That is the only place OpenTelemetry can start early enough for the
 * auto-instrumentation hooks to catch pg and http.
 */
export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;
  const { startTelemetry } = await import("@smos/telemetry");
  await startTelemetry({
    serviceName: process.env["OTEL_SERVICE_NAME"] ?? "smos-web",
    endpoint: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  });
}
