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
 * M2B: one message this system received from a real customer, normalised
 * to a channel-agnostic shape by `parseInbound` below.
 */
export interface InboundMessage {
  channelMessageId: string;
  channelContactId: string;
  text: string;
  receivedAt: Date;
}

/**
 * The shape every channel integration (Meta, Zalo, others later) must
 * implement. `healthCheck` lets a caller probe reachability/auth without
 * side effects; `publish` performs a broadcast-style post; `sendDirectMessage`
 * (M2B) performs one customer-facing reply inside an existing thread --
 * distinct operations with distinct ban-avoidance rules, which is why they
 * are two methods rather than one parameterised by "kind".
 */
export interface ChannelAdapter {
  readonly name: string;
  healthCheck(): Promise<boolean>;
  publish(input: PublishInput): Promise<PublishResult>;
  sendDirectMessage(input: {
    channelContactId: string;
    text: string;
    idempotencyKey: string;
  }): Promise<{ channelMessageId: string }>;
}

interface ZaloWebhookEventBody {
  event_name: string;
  sender: { id: string };
  timestamp: string;
  message?: { msg_id: string; text?: string };
}

function isZaloWebhookEventBody(value: unknown): value is ZaloWebhookEventBody {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["event_name"] !== "string") return false;
  if (typeof v["timestamp"] !== "string") return false;
  const sender = v["sender"];
  if (typeof sender !== "object" || sender === null || typeof (sender as Record<string, unknown>)["id"] !== "string") return false;
  const message = v["message"];
  if (message !== undefined) {
    if (typeof message !== "object" || message === null) return false;
    if (typeof (message as Record<string, unknown>)["msg_id"] !== "string") return false;
  }
  return true;
}

/**
 * M2B (D1): Zalo-shaped for this milestone -- Zalo OA is the only channel
 * being built. A future second channel adapter will need this to dispatch
 * on the payload's own shape rather than assume Zalo; that generalisation
 * is a deliberate, visible change to this one function when it happens,
 * not a silent assumption every caller has to remember today.
 *
 * A non-text event (follow, unfollow, click-button, sticker -- text-only
 * is this milestone's scope) is not an error: it returns an empty array,
 * not a thrown exception. Malformed bytes or a body that does not match a
 * recognised Zalo webhook event shape at all IS an error -- the caller
 * asked this function to parse a genuine webhook delivery.
 */
export function parseInbound(rawBody: string): InboundMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error("parseInbound: rawBody is not valid JSON");
  }
  if (!isZaloWebhookEventBody(parsed)) {
    throw new Error("parseInbound: rawBody does not match a recognised Zalo OA webhook event shape");
  }
  if (parsed.message === undefined || parsed.message.text === undefined || parsed.message.text.trim() === "") {
    return [];
  }
  const receivedAtMs = Number(parsed.timestamp);
  if (!Number.isFinite(receivedAtMs)) {
    throw new Error(`parseInbound: timestamp "${parsed.timestamp}" is not a valid epoch-millisecond number`);
  }
  return [
    {
      channelMessageId: parsed.message.msg_id,
      channelContactId: parsed.sender.id,
      text: parsed.message.text,
      receivedAt: new Date(receivedAtMs),
    },
  ];
}
