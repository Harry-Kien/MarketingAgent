import { describe, expect, it } from "vitest";
import { newId } from "@smos/domain";
import { resolveWorkspace, UnauthorizedError } from "./session.ts";

const userId = newId();
const workspaceId = newId();

describe("resolveWorkspace", () => {
  it("returns the workspace bound to the session", async () => {
    const r = await resolveWorkspace({
      getSession: async () => ({ userId }),
      lookupWorkspace: async () => workspaceId,
    });
    expect(r).toEqual({ userId, workspaceId });
  });

  it("refuses when there is no session", async () => {
    await expect(
      resolveWorkspace({ getSession: async () => null, lookupWorkspace: async () => workspaceId }),
    ).rejects.toThrow(UnauthorizedError);
  });

  it("refuses when the user belongs to no workspace", async () => {
    await expect(
      resolveWorkspace({ getSession: async () => ({ userId }), lookupWorkspace: async () => null }),
    ).rejects.toThrow(UnauthorizedError);
  });

  it("ignores any workspace id supplied by the caller", async () => {
    const attacker = newId();
    const r = await resolveWorkspace(
      { getSession: async () => ({ userId }), lookupWorkspace: async () => workspaceId },
      { workspaceId: attacker } as never,
    );
    expect(r.workspaceId).toBe(workspaceId);
    expect(r.workspaceId).not.toBe(attacker);
  });
});
