import { createHmac, timingSafeEqual } from "node:crypto";

const SIG_PREFIX = "sha256=";
const HEX_RE = /^[0-9a-f]+$/i;

/**
 * Task 7 (T7 webhook giả): the ONE place external bytes enter this system,
 * so this function is the security boundary -- the whole route only ever
 * calls this before parsing or acting on the body at all.
 *
 * Verifies a Meta-style `X-Hub-Signature-256: sha256=<hex>` header against
 * `body` (the exact raw bytes as received, never a re-serialized form --
 * re-stringifying JSON can change whitespace/key order and would make a
 * genuinely valid signature fail) using HMAC-SHA256 and `secret`.
 *
 * Every rejection path (missing header, wrong algorithm prefix, non-hex
 * payload, wrong length, wrong value) returns `false`; none of them throw,
 * and none of them take a data-dependent amount of time on the *value*
 * being compared -- `timingSafeEqual` only runs once both buffers are
 * already known to be equal length, so a length mismatch is rejected
 * before it, and the final byte-for-byte comparison itself is
 * constant-time in the number of bytes that differ.
 */
export function verifySignature(body: string, header: string, secret: string): boolean {
  if (!header || !header.startsWith(SIG_PREFIX)) return false;
  const provided = header.slice(SIG_PREFIX.length);
  if (provided.length === 0 || !HEX_RE.test(provided)) return false;

  const expectedHex = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  const providedBuf = Buffer.from(provided, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");

  // A length mismatch must never reach timingSafeEqual, which throws on
  // unequal-length buffers -- checking first, and returning false rather
  // than throwing, keeps this function's contract "never throws" for any
  // input shape.
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
