import { assertRenderable, isId } from "@smos/domain";
import { requireWorkspace } from "../../../../server/auth.ts";
import { UnauthorizedError } from "../../../../server/session.ts";
import { getPool } from "../../../../server/db.ts";
import { getApprovalRequestDetail } from "../../../../server/queries.ts";
import { submitApproval } from "../../../../server/actions/submit-approval.ts";
import { PageState } from "../../../../ui/PageState.tsx";
import { ApprovalDecisionForm } from "../../../../ui/ApprovalDecisionForm.tsx";
import { t } from "../../../../i18n/index.ts";

/**
 * Approval Center detail: diff (before/after), every citation with its URL
 * and access date, policy flags carrying `ruleId@ruleVersion`, the resolved
 * target channel, and estimated impact explicitly labelled "[ước lượng]" so
 * it is never mistaken for a measured number. No chain-of-thought is ever
 * fetched or rendered here -- `getApprovalRequestDetail` does not select
 * anything resembling reasoning trace, only the request's own recorded
 * fields.
 *
 * The one rule this whole page exists to protect: approving is a decision
 * only a human can make. The form below is the ONLY way this page can ever
 * reach a decision -- it renders three distinct submit buttons (approve /
 * reject / request changes), each posting its own literal `decision` value
 * plus whatever the founder actually typed into a required `reason` field,
 * to `submitApproval` (a real Next.js Server Action, `../../../../server/
 * actions/submit-approval.ts`). There is no default decision, no
 * pre-filled reason, and no code path on this page that calls
 * `submitApproval` except that form being physically submitted.
 */
export default async function ApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let workspaceId;
  try {
    ({ workspaceId } = await requireWorkspace());
  } catch (error) {
    if (error instanceof UnauthorizedError) return <PageState kind="unauthorized" />;
    throw error;
  }

  if (!isId(id)) {
    return <PageState kind="empty" />;
  }

  let detail;
  try {
    detail = await getApprovalRequestDetail(getPool(), workspaceId, id);
  } catch {
    return <PageState kind="error" />;
  }

  if (detail === null) {
    return <PageState kind="empty" />;
  }

  // The one place this page decides whether an approve/reject/request-
  // changes form may render at all: the same domain function
  // `performApproval` itself calls before ever recording a decision. If it
  // throws, the reason shown is one of the two Vietnamese messages already
  // defined for exactly this case (vi.ts) -- never the raw (English)
  // exception text.
  let disabledReason: string | null = null;
  try {
    assertRenderable({
      id: detail.id,
      workspaceId: detail.workspaceId,
      campaignId: detail.campaignId,
      contentVersionId: detail.contentVersionId,
      targetChannel: detail.targetChannel,
      policyFlags: [],
      evidenceCitationIds: detail.evidence.map((e) => e.id),
      estimatedImpact: detail.estimatedImpact,
      createdAt: detail.createdAt,
    });
  } catch {
    disabledReason = detail.evidence.length === 0 ? t("approval.missingEvidence") : t("approval.disconnected");
  }

  return (
    <div>
      <h1 className="font-display" style={{ lineHeight: "var(--lh-heading)", margin: 0 }}>
        {t("approval.pendingTitle")}
      </h1>

      <section>
        <h2 className="font-display" style={{ lineHeight: "var(--lh-heading)" }}>
          {t("content.diffBefore")}
        </h2>
        <p style={{ whiteSpace: "pre-wrap", lineHeight: "var(--lh-body)", color: "var(--color-ink2)" }}>
          {detail.content.previousPublicationContent ?? t("state.empty")}
        </p>
        <h2 className="font-display" style={{ lineHeight: "var(--lh-heading)" }}>
          {t("content.diffAfter")}
        </h2>
        <p style={{ whiteSpace: "pre-wrap", lineHeight: "var(--lh-body)" }}>
          {detail.content.publicationContent ?? detail.content.body}
        </p>
      </section>

      <section>
        <h2 className="font-display" style={{ lineHeight: "var(--lh-heading)" }}>
          {t("approval.evidence")}
        </h2>
        {detail.evidence.length === 0 ? (
          <p>{t("approval.missingEvidence")}</p>
        ) : (
          <ul>
            {detail.evidence.map((citation) => (
              <li key={citation.id} style={{ lineHeight: "var(--lh-body)" }}>
                <a href={citation.url} style={{ color: "var(--color-cham)" }}>
                  {citation.url}
                </a>{" "}
                — {t("approval.citationAccessedAt")}: {citation.accessedAt.toISOString()}
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail.policyFlags.length > 0 && (
        <section>
          <h2 className="font-display" style={{ lineHeight: "var(--lh-heading)" }}>
            {t("approval.policyFlags")}
          </h2>
          <ul>
            {detail.policyFlags.map((flag) => (
              <li key={`${flag.ruleId}@${flag.ruleVersion}`} style={{ lineHeight: "var(--lh-body)" }}>
                {flag.ruleId}@{flag.ruleVersion}: {flag.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p>
        {t("approval.targetChannel")}: {detail.targetChannel}
      </p>
      {detail.estimatedImpact !== null && (
        <p>
          {t("approval.estimatedImpact")} [{t("approval.estimatedImpactLabel")}]: {detail.estimatedImpact}
        </p>
      )}

      {detail.decision !== null ? (
        <p style={{ color: "var(--color-ink2)" }}>
          {t("approval.alreadyDecided")} — {t("approval.decidedAt")}: {detail.decision.decidedAt.toISOString()}
        </p>
      ) : disabledReason !== null ? (
        <p style={{ color: "var(--color-brick)" }}>{disabledReason}</p>
      ) : (
        <ApprovalDecisionForm action={submitApproval.bind(null, detail.id)} />
      )}
    </div>
  );
}
