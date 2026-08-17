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
/**
 * Late-review CRITICAL 2: the workspace a delivery claims to be for was NOT
 * covered by the signature. There was one global `META_WEBHOOK_SECRET`, the
 * workspace came from the URL path only, and so workspace A's captured
 * `(body, sha256=...)` pair replayed at `POST /api/webhooks/meta/<B>`
 * verified perfectly and returned 200 -- writing A's full payload and A's
 * Meta post id into B's `webhook_delivery`, and permanently burning that
 * delivery id for B.
 *
 * The choice made here, deliberately, between the two available fixes:
 *
 *   (1) Include the workspace id in the signed payload (sign `wsId + body`
 *       under the one global secret). This binds the workspace -- and
 *       nothing else. One leaked secret still forges deliveries for EVERY
 *       tenant, and every sender still has to hold that all-tenant secret.
 *
 *   (2) A per-workspace secret. This binds the workspace by construction --
 *       the KEY differs, so there is no concatenated "signed payload" whose
 *       framing could be got wrong and re-split -- AND it limits blast
 *       radius: a leaked workspace secret forges deliveries for that one
 *       tenant, never the fleet.
 *
 * (2) is chosen. The per-workspace secret is DERIVED from the root secret
 * rather than stored, because no vault exists in this milestone --
 * `credential_reference.vault_key` is deliberately only an opaque pointer
 * this database never resolves (0028_integration.sql), so there is nowhere
 * to put a genuinely independent per-tenant secret today. Derivation buys
 * the isolation immediately with no new storage and no new dependency:
 * HMAC-SHA256 is a PRF, so `HMAC(root, "smos:meta-webhook:v1:" +
 * workspaceId)` is computationally independent per workspace, and holding
 * one derived secret reveals nothing about the root or about any other
 * workspace's secret.
 *
 * What derivation does NOT buy, stated plainly: leaking the ROOT secret
 * still compromises every workspace. That is strictly no worse than the
 * global scheme it replaces, and when a real vault lands only this one
 * function changes -- the wire format, the route and every test already
 * speak in terms of "the secret for THIS workspace".
 *
 * The version tag in the label is load-bearing: rotating the derivation
 * scheme later means bumping `v1`, which invalidates every previously issued
 * workspace secret at once instead of silently honouring both.
 */
export function deriveWorkspaceSecret(rootSecret: string, workspaceId: string): string {
  return createHmac("sha256", rootSecret).update(`smos:meta-webhook:v1:${workspaceId}`).digest("hex");
}

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
