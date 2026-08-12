/**
 * Every field an adapter needs to publish a piece of already-approved
 * content exactly once. `idempotencyKey` lets a retried job hit the same
 * external operation instead of creating a duplicate post; `contentHash`
 * lets the caller prove, at the call site, that what is about to be
 * published still matches what a human approved.
 */
export interface PublishInput {
  idempotencyKey: string;
  publicationContent: string;
  contentHash: string;
  targetAccountId: string;
}

/**
 * `evidence` is a free-form, redaction-safe record of what the channel
 * returned (status, response headers of interest, etc.) kept for audit --
 * never raw credentials.
 */
export interface PublishResult {
  externalId: string;
  permalink: string;
  evidence: Record<string, unknown>;
}

/**
 * The shape every channel integration (Meta today, others later) must
 * implement. `healthCheck` lets a caller probe reachability/auth without
 * side effects; `publish` performs the one side-effecting call.
 */
export interface ChannelAdapter {
  name: string;
  healthCheck(): Promise<boolean>;
  publish(input: PublishInput): Promise<PublishResult>;
}
