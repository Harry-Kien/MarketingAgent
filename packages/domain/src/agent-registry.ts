import { AgentNotActivatedError } from "./errors.ts";
import type { Id } from "./ids.ts";

/**
 * Blueprint 11.2.1: the full fifteen-role agent org chart. Every role is a
 * contract (a row this registry can describe) whether or not it is
 * activated for the current milestone -- see M1_ACTIVATED_AGENTS below.
 */
export const ALL_AGENT_ROLES = [
  "orchestrator",
  "research",
  "icp_strategist",
  "brand_offer_strategist",
  "campaign_planner",
  "content",
  "creative_director",
  "seo_aeo",
  "social_distribution",
  "crm_lifecycle",
  "paid_media_advisor",
  "cro_experiment",
  "data_analyst",
  "qa_brand_safety",
  "integration_reliability",
] as const;

export type AgentRole = (typeof ALL_AGENT_ROLES)[number];

/**
 * Exactly these four run in M1; the rest are contracts only. This is the
 * primary cost control for P2: assertActivated is what stops a
 * non-activated agent from ever being dispatched, which means it never
 * creates an AgentRun and never calls a paid model provider.
 */
export const M1_ACTIVATED_AGENTS = ["orchestrator", "research", "content", "qa_brand_safety"] as const;

export interface AgentRegistryEntry {
  role: AgentRole;
  versionId: Id;
  activated: boolean;
  toolAllowlist: string[];
  prohibitedActions: string[];
}

/**
 * Throws AgentNotActivatedError both when the role is missing from the
 * registry entirely and when it is present but not activated -- callers
 * must not be able to distinguish "unknown role" from "known but
 * deactivated role" and treat only one of the two as a hard stop.
 */
export function assertActivated(role: AgentRole, registry: AgentRegistryEntry[]): void {
  const entry = registry.find((e) => e.role === role);
  if (entry === undefined) {
    throw new AgentNotActivatedError(`Agent role ${role} is not present in the registry`);
  }
  if (!entry.activated) {
    throw new AgentNotActivatedError(`Agent role ${role} is registered but not activated`);
  }
}
