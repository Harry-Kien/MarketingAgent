/**
 * Single source of truth for the design system. CSS is generated from here so
 * tests can assert on the tokens themselves, which is how ADR-008 C1 stays
 * enforced instead of drifting in a stylesheet.
 */
export const tokens = {
  color: {
    light: {
      paper: "#FBFBFA", surface: "#FFFFFF", ink: "#16181C", ink2: "#4A505C",
      rule: "#E3E5E9", cham: "#29406B", tho: "#A9701A", moss: "#2F6B4F",
      brick: "#9B3226", slate: "#445A78",
    },
    dark: {
      paper: "#101216", surface: "#181B21", ink: "#F2F4F7", ink2: "#A6AEBC",
      rule: "#262A32", cham: "#7C9BD1", tho: "#D9A047", moss: "#5FA37E",
      brick: "#D6705F", slate: "#8FA6C4",
    },
  },
  /** Measured in V6: below 1.3 Vietnamese diacritics collide. */
  lineHeight: { heading: 1.3, label: 1.3, table: 1.4, body: 1.5 },
  space: [4, 8, 12, 16, 24, 32, 48, 64],
  fontSize: [11, 12, 13, 14, 16, 18, 22, 28, 36],
  radius: { none: 0, sm: 2, md: 4, lg: 6 },
  font: {
    display: "'Archivo', system-ui, sans-serif",
    body: "'Be Vietnam Pro', system-ui, sans-serif",
    mono: "'IBM Plex Mono', ui-monospace, monospace",
  },
} as const;

export function toCssVars(mode: "light" | "dark"): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(tokens.color[mode])) lines.push(`  --color-${k}: ${v};`);
  for (const [k, v] of Object.entries(tokens.lineHeight)) lines.push(`  --lh-${k}: ${v};`);
  for (const [k, v] of Object.entries(tokens.font)) lines.push(`  --font-${k}: ${v};`);
  for (const [k, v] of Object.entries(tokens.radius)) lines.push(`  --radius-${k}: ${v}px;`);
  return lines.join("\n");
}
