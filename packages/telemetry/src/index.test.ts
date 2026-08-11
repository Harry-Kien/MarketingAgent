import { describe, expect, it } from "vitest";
import { startTelemetry } from "./index.ts";

describe("startTelemetry", () => {
  it("starts and returns a shutdown function that resolves", async () => {
    const stop = await startTelemetry({ serviceName: "smos-telemetry-test" });
    expect(stop).toBeTypeOf("function");
    await expect(stop()).resolves.toBeUndefined();
  });

  it("shuts down cleanly when no OTLP endpoint is configured", async () => {
    // Without an endpoint the SDK would otherwise default to
    // http://localhost:4318 and reject on shutdown with ECONNREFUSED,
    // which turns every local run and every CI run into a failure.
    const stop = await startTelemetry({ serviceName: "smos-no-endpoint" });
    await expect(stop()).resolves.toBeUndefined();
  });

  it("shuts down cleanly twice", async () => {
    const stop = await startTelemetry({ serviceName: "smos-double-stop" });
    await stop();
    await expect(stop()).resolves.toBeUndefined();
  });
});
