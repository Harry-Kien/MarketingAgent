import type { FetchLike } from "../guarded-fetch.ts";
import { AdapterError } from "../errors.ts";
import type { ChannelAdapter, PublishInput, PublishResult } from "../adapter.ts";
import { createZaloClient, type ZaloClientConfig } from "./client.ts";

export interface ZaloAdapterConfig extends ZaloClientConfig {}

/**
 * Wraps the raw Zalo OA client (Task 3) into the `ChannelAdapter` shape.
 * `publish` is refused outright rather than implemented as a broadcast --
 * see the throw below for why. Task 6 wires the reply-window and
 * complaint-rate ban-avoidance gate into `sendDirectMessage` here.
 */
export function createZaloAdapter(cfg: ZaloAdapterConfig, fetchImpl: FetchLike = fetch): ChannelAdapter {
  const client = createZaloClient(cfg, fetchImpl);

  return {
    name: "zalo",

    async healthCheck() {
      try {
        // No dedicated health endpoint exists in Zalo's OA API. A
        // getProfile round trip against a synthetic id is the same
        // lightweight-reachability-probe shape Meta's healthCheck uses: an
        // API-level rejection (we reached the API and got a real, if
        // negative, answer) still counts as reachable; a network/timeout
        // failure does not.
        await client.getProfile("healthcheck-probe").catch((err: unknown) => {
          if (err instanceof AdapterError && err.kind !== "upstream_unavailable") return;
          throw err;
        });
        return true;
      } catch {
        return false;
      }
    },

    async publish(_input: PublishInput): Promise<PublishResult> {
      // D1/4.5 (ban avoidance): Zalo OA has no safe, non-bulk equivalent of
      // Meta's page-feed publish. A broadcast-shaped call is exactly the
      // kind of bulk send that risks the >2% spam-complaint lockout this
      // milestone exists to avoid (see reply-window.ts, Task 6). Refused
      // outright, not merely undocumented.
      throw new AdapterError(
        "permanent_rejection",
        "Zalo OA channel adapter does not support publish (broadcast); use sendDirectMessage inside a customer-initiated thread only",
      );
    },

    async sendDirectMessage(input) {
      // Known limit, stated rather than hidden: Zalo's OA send API has no
      // server-side idempotency key. `input.idempotencyKey` is accepted for
      // interface conformance; genuine duplicate-send protection must
      // happen at the caller (checking `message` for an existing row with
      // this channelContactId/idempotencyKey before ever calling
      // sendDirectMessage) -- faking client-side dedupe here would not
      // actually protect a real customer from a duplicate message.
      const result = await client.sendMessage(input.channelContactId, input.text);
      return { channelMessageId: result.messageId };
    },
  };
}
