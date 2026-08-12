import { describe, expect, it } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor, BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";
import { withSpan } from "./spans.ts";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
trace.setGlobalTracerProvider(provider);

describe("withSpan", () => {
  it("records a span with its attributes", async () => {
    exporter.reset();
    const result = await withSpan("agent.run", { "agent.role": "content", "workspace.id": "ws-1" }, async () => "ok");
    expect(result).toBe("ok");
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("agent.run");
    expect(span?.attributes["agent.role"]).toBe("content");
    expect(span?.attributes["workspace.id"]).toBe("ws-1");
  });

  it("marks the span as error and rethrows", async () => {
    exporter.reset();
    await expect(
      withSpan("adapter.publish", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const [span] = exporter.getFinishedSpans();
    // SpanStatusCode.ERROR === 2
    expect(span?.status.code).toBe(2);
  });

  it("does not put secrets into attributes", async () => {
    exporter.reset();
    await withSpan("adapter.publish", { token: "EAAsecret" } as never, async () => "ok");
    const [span] = exporter.getFinishedSpans();
    expect(JSON.stringify(span?.attributes)).not.toContain("EAAsecret");
  });

  it("always ends the span, even on throw", async () => {
    exporter.reset();
    await expect(
      withSpan("adapter.publish", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow();
    const [span] = exporter.getFinishedSpans();
    expect(span?.duration).toBeDefined();
    expect(span?.ended).toBe(true);
  });

  it("does not swallow a non-Error throw, and still ends and marks the span", async () => {
    exporter.reset();
    await expect(
      withSpan("adapter.publish", {}, async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "not an error object";
      }),
    ).rejects.toBe("not an error object");
    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(2);
    expect(span?.ended).toBe(true);
  });
});
