import { t } from "../i18n/index.ts";
import { tokens } from "./tokens.ts";

export const PAGE_STATE_KINDS = [
  "loading",
  "empty",
  "error",
  "partial",
  "stale",
  "unauthorized",
  "disconnected",
] as const;
export type PageStateKind = (typeof PAGE_STATE_KINDS)[number];

/**
 * Every page must be able to render all seven of these (Global Constraint:
 * "Mọi trang có đủ 7 state"). Retry is offered only for kinds where trying
 * again can plausibly change the outcome: a transient load error, data that
 * is merely old, or a broken integration link. It is withheld for
 * "unauthorized" (retrying changes nothing without a different session) and
 * for "empty"/"partial" (there is no failure to retry, only a state to
 * accept or wait out).
 */
const RETRYABLE: ReadonlySet<PageStateKind> = new Set(["error", "stale", "disconnected"]);

export function PageState({
  kind,
  detail,
  onRetry,
}: {
  kind: PageStateKind;
  detail?: string;
  onRetry?: () => void;
}) {
  const showRetry = onRetry !== undefined && RETRYABLE.has(kind);
  return (
    <div
      role="status"
      aria-live={kind === "error" ? "assertive" : "polite"}
      style={{ padding: tokens.space[4], color: "var(--color-ink2)", lineHeight: "var(--lh-body)" }}
    >
      <p style={{ margin: 0, color: "var(--color-ink)" }}>{t(`state.${kind}`)}</p>
      {detail !== undefined && <p style={{ margin: `${tokens.space[0]}px 0 0` }}>{detail}</p>}
      {showRetry && (
        <button type="button" onClick={onRetry} style={{ marginTop: tokens.space[2] }}>
          {t("state.retry")}
        </button>
      )}
    </div>
  );
}
