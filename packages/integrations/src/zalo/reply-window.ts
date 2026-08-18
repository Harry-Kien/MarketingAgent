import { AdapterError } from "../errors.ts";

/**
 * D1/4.5: Zalo cuts an OA's send quota by tier and locks the offending
 * message template outright once its spam-complaint rate crosses 2%;
 * repeated or serious violations cost the OA permanently, with its data
 * purged 30 days later. Nothing in this module can observe Zalo's own
 * complaint counter directly (the OA API does not expose one in this
 * milestone) -- `getComplaintRate` is an injected provider so the caller
 * supplies the real number (eventually a scheduled Zalo Insights pull or
 * the founder's own dashboard), and this module's only job is to refuse to
 * send once that number crosses the configured threshold, set BELOW
 * Zalo's own 2% lockout line by default so the circuit trips on our own
 * numbers before Zalo's enforcement ever acts on the OA.
 */
export interface ReplyWindowState {
  /** When the customer's most recent inbound message in this thread
   * arrived, or null if this contact has never messaged in. */
  lastCustomerMessageAt: Date | null;
}

export type ComplaintRateProvider = () => Promise<number>;

const FREE_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h free-message window
const OPENAPI_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7-day OpenAPI (template) window
export const DEFAULT_COMPLAINT_RATE_THRESHOLD = 0.015; // 1.5%, deliberately below Zalo's 2% lockout line

export class ReplyWindowClosedError extends AdapterError {
  constructor(message: string) {
    super("permanent_rejection", message);
    this.name = "ReplyWindowClosedError";
  }
}

export class ComplaintThresholdExceededError extends AdapterError {
  constructor(message: string) {
    super("permanent_rejection", message);
    this.name = "ComplaintThresholdExceededError";
  }
}

/**
 * Never bulk-send, and never reply outside a thread the customer started.
 * A contact who has never sent an inbound message has no open window at
 * all -- refused, not merely "outside 7 days". Throws synchronously,
 * BEFORE any HTTP call is made; callers (createZaloAdapter's
 * sendDirectMessage) must call this before touching the network, never
 * after.
 */
export function assertWithinReplyWindow(state: ReplyWindowState, now: Date): void {
  if (state.lastCustomerMessageAt === null) {
    throw new ReplyWindowClosedError(
      "Zalo sendDirectMessage refused: this contact has no customer-initiated thread open -- the agent may only reply inside a thread the customer started",
    );
  }
  const elapsedMs = now.getTime() - state.lastCustomerMessageAt.getTime();
  if (elapsedMs > OPENAPI_WINDOW_MS) {
    throw new ReplyWindowClosedError(
      `Zalo sendDirectMessage refused: the 7-day OpenAPI reply window closed ${Math.floor((elapsedMs - OPENAPI_WINDOW_MS) / 1000)}s ago`,
    );
  }
  // Inside the outer 7-day window but past the 48h free window: this
  // milestone has no paid-template send path implemented, so treating it
  // as "allowed" here would silently attempt a send Zalo will itself
  // reject (or bill) as an unsupported message class. Refused explicitly
  // rather than left to fail downstream.
  if (elapsedMs > FREE_WINDOW_MS) {
    throw new ReplyWindowClosedError(
      `Zalo sendDirectMessage refused: the 48-hour free-message window closed ${Math.floor((elapsedMs - FREE_WINDOW_MS) / 1000)}s ago; ` +
        "the 7-day OpenAPI template window is still open but no paid-template send path exists in this milestone",
    );
  }
}

/**
 * Stops automatically at a threshold set BELOW Zalo's real 2% lockout, so
 * the circuit trips on our own numbers before Zalo's enforcement ever acts
 * on the OA. `threshold` defaults to DEFAULT_COMPLAINT_RATE_THRESHOLD but
 * is a parameter, not a hardcoded constant, so the founder can tighten it
 * from configuration -- the bound below refuses any attempt to loosen it
 * past 2%.
 */
export async function assertBelowComplaintThreshold(
  getComplaintRate: ComplaintRateProvider,
  threshold: number = DEFAULT_COMPLAINT_RATE_THRESHOLD,
): Promise<void> {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 0.02) {
    throw new Error(`assertBelowComplaintThreshold: threshold must be a finite number in (0, 0.02), got ${threshold}`);
  }
  const rate = await getComplaintRate();
  if (!Number.isFinite(rate) || rate < 0) {
    // An unreadable/malformed complaint rate must fail closed, not open --
    // sending blind is exactly the risk this module exists to prevent.
    throw new ComplaintThresholdExceededError(
      `Zalo sendDirectMessage refused: the current spam-complaint rate could not be read as a valid number (got ${String(rate)}), and this gate fails closed`,
    );
  }
  if (rate >= threshold) {
    throw new ComplaintThresholdExceededError(
      `Zalo sendDirectMessage refused: spam-complaint rate ${(rate * 100).toFixed(2)}% is at or above the configured threshold ${(threshold * 100).toFixed(2)}%`,
    );
  }
}
