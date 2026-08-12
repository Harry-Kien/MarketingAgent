import { t } from "../i18n/index.ts";

/**
 * The one real approve/reject/request-changes control surface in the app,
 * extracted out of `approvals/[id]/page.tsx` verbatim (same markup, same
 * three literal `value`s, same required `reason` textarea with no default)
 * so it can be exercised in isolation -- specifically by the E11 keyboard
 * harness (`apps/web/e2e/build-harness.mjs`), which cannot render the real
 * page (it needs a live session + Postgres) but must still drive real
 * keyboard interaction against the actual production markup, not a
 * look-alike stand-in. Extracting this changes nothing about how a decision
 * reaches `submitApproval` -- `action` is still bound to the exact same
 * server action by the caller.
 */
export function ApprovalDecisionForm({ action }: { action: (formData: FormData) => void | Promise<void> }) {
  return (
    <form action={action}>
      <label htmlFor="approval-reason">{t("approval.reasonLabel")}</label>
      <textarea id="approval-reason" name="reason" required minLength={1} />
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" name="decision" value="approve">
          {t("approval.approve")}
        </button>
        <button type="submit" name="decision" value="reject">
          {t("approval.reject")}
        </button>
        <button type="submit" name="decision" value="request_changes">
          {t("approval.requestChanges")}
        </button>
      </div>
    </form>
  );
}
