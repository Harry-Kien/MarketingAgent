import { describe, expect, it } from "vitest";
import { parseInbound } from "./adapter.ts";

function zaloEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    app_id: "test-app",
    event_name: "user_send_text",
    sender: { id: "user-1" },
    timestamp: "1700000000000",
    message: { msg_id: "msg-1", text: "xin chao" },
    ...overrides,
  });
}

describe("parseInbound", () => {
  it("parses a genuine text message into one InboundMessage", () => {
    const result = parseInbound(zaloEvent());
    expect(result).toEqual([
      { channelMessageId: "msg-1", channelContactId: "user-1", text: "xin chao", receivedAt: new Date(1700000000000) },
    ]);
  });

  it("returns an empty array for a non-text event (e.g. follow) -- not an error", () => {
    expect(parseInbound(zaloEvent({ event_name: "follow", message: undefined }))).toEqual([]);
  });

  it("returns an empty array when message.text is blank", () => {
    expect(parseInbound(zaloEvent({ message: { msg_id: "msg-2", text: "   " } }))).toEqual([]);
  });

  it("throws on bytes that are not valid JSON", () => {
    expect(() => parseInbound("not-json{{")).toThrow(/not valid JSON/);
  });

  it("throws on JSON that does not match a recognised Zalo webhook event shape", () => {
    expect(() => parseInbound(JSON.stringify({ hello: "world" }))).toThrow(/recognised Zalo/);
  });

  it("throws on a non-numeric timestamp", () => {
    expect(() => parseInbound(zaloEvent({ timestamp: "not-a-number" }))).toThrow(/timestamp/);
  });
});
