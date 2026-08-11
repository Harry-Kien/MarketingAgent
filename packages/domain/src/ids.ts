import { randomUUID } from "node:crypto";

export type Id = string & { readonly __brand: "Id" };

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** UUID v7 so ids sort by creation time, which keeps audit reads cheap. */
export function newId(): Id {
  const bytes = Buffer.from(randomUUID().replace(/-/g, ""), "hex");
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}` as Id;
}

export function isId(value: unknown): value is Id {
  return typeof value === "string" && UUID_V7.test(value);
}
