import { describe, expect, it } from "vitest";
import { startTelemetry } from "./index.js";

describe("startTelemetry", () => {
  it("starts and returns a shutdown function that resolves", async () => {
    const stop = await startTelemetry({ serviceName: "smos-telemetry-test" });
    expect(stop).toBeTypeOf("function");
    await expect(stop()).resolves.toBeUndefined();
  }, 30_000);
});
