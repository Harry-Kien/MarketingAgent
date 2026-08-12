import { messages } from "./vi.ts";

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type MessageKey = Leaves<typeof messages>;

export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  const found = key.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], messages);
  if (typeof found !== "string") throw new Error(`Unknown message key: ${key}`);
  // Unmatched placeholders stay visible on purpose: a blank label in production
  // is harder to notice than a literal {count}.
  return found.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}
