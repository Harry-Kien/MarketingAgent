/**
 * Task 7: "confirm a large body cannot exhaust memory." `Content-Length` is
 * attacker-controlled and can simply lie (absent, wrong, or a chunked
 * transfer with no declared length at all), so the only real defense is to
 * never trust it and instead cap the number of bytes actually pulled off
 * the stream -- the moment the running total crosses `maxBytes`, reading
 * stops (`reader.cancel()`) and this throws, before ever holding
 * substantially more than `maxBytes` in memory at once. This is a stronger
 * guarantee than "check `.length` after buffering everything", which is
 * exactly the shape of bug that lets an unbounded body exhaust memory
 * before the check ever runs.
 */
export const MAX_WEBHOOK_BODY_BYTES = 1_000_000; // 1 MB -- generous headroom over any real Meta webhook payload.

export class BodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Webhook body exceeded the ${maxBytes} byte cap`);
    this.name = "BodyTooLargeError";
  }
}

export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number = MAX_WEBHOOK_BODY_BYTES,
): Promise<string> {
  if (body === null) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("body exceeded cap").catch(() => undefined);
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}
