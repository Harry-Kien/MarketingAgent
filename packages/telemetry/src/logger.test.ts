import { describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  it("emits one JSON line per call", () => {
    const sink = vi.fn();
    createLogger(sink).info("campaign created", { campaignId: "c1" });
    expect(sink).toHaveBeenCalledOnce();
    const line = JSON.parse(sink.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(line["level"]).toBe("info");
    expect(line["msg"]).toBe("campaign created");
    expect(line["campaignId"]).toBe("c1");
    expect(typeof line["time"]).toBe("string");
  });

  it("redacts sensitive fields", () => {
    const sink = vi.fn();
    createLogger(sink).error("auth failed", { apiKey: "sk-live-1", user: "kien" });
    const line = JSON.parse(sink.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(line["apiKey"]).toBe("[redacted]");
    expect(line["user"]).toBe("kien");
  });

  it("never lets a field overwrite the reserved level key", () => {
    const sink = vi.fn();
    createLogger(sink).warn("x", { level: "sneaky" });
    const line = JSON.parse(sink.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(line["level"]).toBe("warn");
  });
});
