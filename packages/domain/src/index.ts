export { type Id, newId, isId } from "./ids.ts";
export { type Actor, isUserActor, isAgentActor } from "./actor.ts";
export {
  DomainError,
  TenantViolationError,
  InvalidTransitionError,
  ApprovalIntegrityError,
  PublicationIntegrityError,
  AgentNotActivatedError,
} from "./errors.ts";
export {
  type LifecycleState,
  type MainState,
  type SideState,
  type TransitionInput,
  type TransitionRecord,
  MAIN_STATES,
  SIDE_STATES,
  canTransition,
  applyTransition,
  createInitialTransition,
} from "./lifecycle.ts";
export { type Campaign, createCampaign, transitionCampaign } from "./campaign.ts";
export {
  type ContentKind,
  type VerificationStatus,
  type SourceCitation,
  type ContentItem,
  type ContentVersion,
  CONTENT_KINDS,
  VERIFICATION_STATUSES,
  createContentItem,
  addVersion,
  canBeVerified,
} from "./content.ts";
