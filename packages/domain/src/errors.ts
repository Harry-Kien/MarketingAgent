export abstract class DomainError extends Error {
  abstract readonly code: string;
  constructor(message: string) { super(message); this.name = new.target.name; }
}
export class TenantViolationError extends DomainError { readonly code = "TENANT_VIOLATION"; }
export class InvalidTransitionError extends DomainError { readonly code = "INVALID_TRANSITION"; }
export class ApprovalIntegrityError extends DomainError { readonly code = "APPROVAL_INTEGRITY"; }
export class PublicationIntegrityError extends DomainError { readonly code = "PUBLICATION_INTEGRITY"; }
export class AgentNotActivatedError extends DomainError { readonly code = "AGENT_NOT_ACTIVATED"; }
