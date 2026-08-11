import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import { ALL_AGENT_ROLES, M1_ACTIVATED_AGENTS, assertActivated, type AgentRegistryEntry } from "./agent-registry.ts";
import { AgentNotActivatedError } from "./errors.ts";

const registry: AgentRegistryEntry[] = ALL_AGENT_ROLES.map((role) => ({
  role,
  versionId: newId(),
  activated: (M1_ACTIVATED_AGENTS as readonly string[]).includes(role),
  toolAllowlist: [],
  prohibitedActions: [],
}));

describe("agent registry", () => {
  it("declares all fifteen roles", () => {
    expect(ALL_AGENT_ROLES).toHaveLength(15);
  });

  it("has no duplicate roles", () => {
    expect(new Set(ALL_AGENT_ROLES).size).toBe(ALL_AGENT_ROLES.length);
  });

  it("activates exactly four in M1", () => {
    expect(M1_ACTIVATED_AGENTS).toHaveLength(4);
    expect(registry.filter((e) => e.activated)).toHaveLength(4);
  });

  it("every M1-activated role appears in the full registry", () => {
    for (const role of M1_ACTIVATED_AGENTS) {
      expect((ALL_AGENT_ROLES as readonly string[]).includes(role)).toBe(true);
    }
  });

  it("allows dispatching an activated agent", () => {
    expect(() => assertActivated("content", registry)).not.toThrow();
  });

  it("refuses dispatching a role that is registered but not activated", () => {
    expect(() => assertActivated("paid_media_advisor", registry)).toThrow(AgentNotActivatedError);
  });

  it("refuses dispatching a role absent from the registry entirely", () => {
    expect(() => assertActivated("content", [])).toThrow(AgentNotActivatedError);
  });
});
