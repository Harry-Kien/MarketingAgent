import { MAIN_STATES, type LifecycleState } from "@smos/domain";
import { t } from "../i18n/index.ts";

const FAILED: ReadonlySet<string> = new Set(["BLOCKED", "FAILED_RETRYABLE", "FAILED_TERMINAL", "CANCELLED"]);

/**
 * The signature element (blueprint's "State Ribbon"). It puts the 11-stop
 * lifecycle state machine into every row so the founder can scan one column
 * and see everything's progress and everything waiting on them, without
 * opening each item. Side states (BLOCKED, FAILED_*, CANCELLED) fall off
 * the main sequence entirely, so the ribbon renders as visibly broken
 * rather than pretending they sit at some stop along the happy path.
 *
 * Colour never carries the only signal: `aria-label` names the state in
 * Vietnamese, and `data-stop` / `data-broken` attributes let anything
 * (including a screen reader style sheet or a test) read the state without
 * relying on the rendered colour.
 */
export function StateRibbon({ state }: { state: LifecycleState }) {
  const broken = FAILED.has(state);
  const currentIndex = broken ? -1 : MAIN_STATES.indexOf(state as (typeof MAIN_STATES)[number]);
  const accent = state === "WAITING_APPROVAL" ? "tho" : "ink";

  return (
    <span
      aria-label={t(`lifecycle.${state}`)}
      role="img"
      data-broken={broken ? "true" : undefined}
      style={{ display: "inline-flex", gap: 2, alignItems: "flex-end", height: 7 }}
    >
      {MAIN_STATES.map((stop, i) => {
        const kind = i < currentIndex ? "done" : i === currentIndex ? "now" : "todo";
        return (
          <i
            key={stop}
            role="presentation"
            aria-hidden="true"
            data-stop={kind}
            data-accent={kind === "now" ? accent : undefined}
            style={{
              display: "block",
              width: 5,
              height: kind === "now" ? 5 : 3,
              background:
                kind === "done"
                  ? "var(--color-ink2)"
                  : kind === "now"
                    ? accent === "tho"
                      ? "var(--color-tho)"
                      : "var(--color-ink)"
                    : "var(--color-rule)",
            }}
          />
        );
      })}
    </span>
  );
}
