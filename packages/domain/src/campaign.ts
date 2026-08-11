import type { Actor } from "./actor.ts";
import { DomainError } from "./errors.ts";
import { newId, type Id } from "./ids.ts";
import { applyTransition, createInitialTransition, type LifecycleState, type TransitionRecord } from "./lifecycle.ts";

class CampaignValidationError extends DomainError {
  readonly code = "CAMPAIGN_INVALID";
}

export interface Campaign {
  readonly id: Id;
  readonly workspaceId: Id;
  readonly goalId: Id;
  readonly name: string;
  readonly state: LifecycleState;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function createCampaign(input: {
  workspaceId: Id;
  goalId: Id;
  name: string;
  actor: Actor;
  correlationId: Id;
}): { campaign: Campaign; transition: TransitionRecord } {
  if (input.name.trim().length === 0) {
    throw new CampaignValidationError("Campaign name cannot be blank");
  }
  const now = new Date();
  const campaign: Campaign = {
    id: newId(),
    workspaceId: input.workspaceId,
    goalId: input.goalId,
    name: input.name.trim(),
    state: "DRAFT",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  const transition = createInitialTransition({
    actor: input.actor,
    reason: "campaign created",
    correlationId: input.correlationId,
    version: 1,
  });
  return { campaign, transition };
}

export function transitionCampaign(
  campaign: Campaign,
  to: LifecycleState,
  opts: { actor: Actor; reason: string; correlationId: Id; hasApprovalDecision?: boolean | undefined },
): { campaign: Campaign; transition: TransitionRecord } {
  const transition = applyTransition({
    from: campaign.state,
    to,
    actor: opts.actor,
    reason: opts.reason,
    correlationId: opts.correlationId,
    version: campaign.version + 1,
    hasApprovalDecision: opts.hasApprovalDecision,
  });
  return {
    campaign: { ...campaign, state: to, version: campaign.version + 1, updatedAt: transition.occurredAt },
    transition,
  };
}
