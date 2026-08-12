import { describe, expect, it } from "vitest";
import { BodyTooLargeError, MAX_WEBHOOK_BODY_BYTES, readBoundedBody } from "./read-bounded-body.ts";

function streamFromString(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * A stream that never ends and hands out a fresh 64 KiB chunk every pull,
 * counting how many chunks were actually taken. A correct bounded reader
 * must stop pulling (and reject) after crossing the cap; an incorrect
 * implementation that buffers the whole body before checking its length
 * would pull forever and this test would time out rather than fail cleanly
 * -- which is itself proof that only a genuinely bounded reader terminates.
 */
function infiniteStream(chunkCount: { value: number }): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(64 * 1024).fill(65);
  return new ReadableStream({
    pull(controller) {
      chunkCount.value += 1;
      controller.enqueue(chunk);
    },
  });
}

describe("readBoundedBody", () => {
  it("reads a small body in full", async () => {
    const text = JSON.stringify({ hello: "world" });
    await expect(readBoundedBody(streamFromString(text))).resolves.toBe(text);
  });

  it("returns an empty string for a null body", async () => {
    await expect(readBoundedBody(null)).resolves.toBe("");
  });

  it("rejects with BodyTooLargeError, never buffering an unbounded stream", async () => {
    const chunkCount = { value: 0 };
    await expect(readBoundedBody(infiniteStream(chunkCount), 1_000_000)).rejects.toBeInstanceOf(BodyTooLargeError);
    // 1,000,000 bytes / 64 KiB chunks needs about 16 chunks to cross the cap.
    // A buffer-everything-first implementation would keep pulling forever
    // (bounded only by process memory) -- this bounds it to a small,
    // deterministic number of chunks instead.
    expect(chunkCount.value).toBeLessThan(64);
  });

  it("honours a custom cap smaller than the default", async () => {
    const text = "x".repeat(100);
    await expect(readBoundedBody(streamFromString(text), 10)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("accepts a body exactly at the cap", async () => {
    const text = "x".repeat(10);
    await expect(readBoundedBody(streamFromString(text), 10)).resolves.toBe(text);
  });

  it("exports a sane default cap", () => {
    expect(MAX_WEBHOOK_BODY_BYTES).toBeGreaterThan(0);
    expect(MAX_WEBHOOK_BODY_BYTES).toBeLessThanOrEqual(5_000_000);
  });
});
