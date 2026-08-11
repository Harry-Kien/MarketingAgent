import { describe, expect, it } from "vitest";
import { newId, isId } from "./ids.ts";
import { isAgentActor, isUserActor, type Actor } from "./actor.ts";
import { ApprovalIntegrityError, TenantViolationError } from "./errors.ts";

describe("ids", () => {
  it("generates unique, sortable v7 uuids", () => {
    const a = newId(); const b = newId();
    expect(a).not.toBe(b);
    expect(isId(a)).toBe(true);
    expect(a < b || a > b).toBe(true);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("rejects non-uuid values", () => {
    expect(isId("nope")).toBe(false);
    expect(isId(42)).toBe(false);
  });
});

describe("actor", () => {
  const user: Actor = { kind: "user", userId: newId() };
  const agent: Actor = { kind: "agent", agentRunId: newId(), agentVersionId: newId() };

  it("distinguishes a user from an agent", () => {
    expect(isUserActor(user)).toBe(true);
    expect(isUserActor(agent)).toBe(false);
    expect(isAgentActor(agent)).toBe(true);
  });
});

describe("errors", () => {
  it("carries a stable code for logging", () => {
    expect(new TenantViolationError("x").code).toBe("TENANT_VIOLATION");
    expect(new ApprovalIntegrityError("x").code).toBe("APPROVAL_INTEGRITY");
  });
});
