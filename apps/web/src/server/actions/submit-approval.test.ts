import { describe, expect, it } from "vitest";
import { newId } from "@smos/domain";
import { UnauthorizedError } from "../session.ts";
import { submitApproval } from "./submit-approval.ts";

/**
 * Adversarial coverage for the one Server Action a browser can actually
 * reach to decide an approval. Two structural guarantees are checked here,
 * both without touching the database:
 *
 * 1. A decision value that isn't one of the three real buttons (forged
 *    FormData, a bug in a future form change, or a client tampering with
 *    the request) is refused before the session is even resolved -- the
 *    validation in `submitApproval` runs strictly before
 *    `requireWorkspace()`.
 * 2. Because `apps/web/src/server/auth.ts`'s session backend is still a
 *    documented stub that always throws `UnauthorizedError` (pending a
 *    real auth backend from another track), NO approval can be granted at
 *    all through the running app today -- the strictest possible state,
 *    not a silent bypass.
 */
describe("submitApproval (adversarial)", () => {
  it("refuses a forged/garbage decision value before ever resolving a session", async () => {
    const formData = new FormData();
    formData.set("decision", "definitely-not-a-real-decision");
    formData.set("reason", "nội dung đạt");
    await expect(submitApproval(newId(), formData)).rejects.toThrow(/decision/i);
  });

  it("refuses a missing reason field before ever resolving a session", async () => {
    const formData = new FormData();
    formData.set("decision", "approve");
    await expect(submitApproval(newId(), formData)).rejects.toThrow(/reason/i);
  });

  it("cannot grant an approval today: the session backend is a documented stub that always refuses", async () => {
    const formData = new FormData();
    formData.set("decision", "approve");
    formData.set("reason", "nội dung đạt");
    await expect(submitApproval(newId(), formData)).rejects.toThrow(UnauthorizedError);
  });
});
