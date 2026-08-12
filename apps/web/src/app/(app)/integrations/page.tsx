import { requireWorkspace } from "../../../server/auth.ts";
import { UnauthorizedError } from "../../../server/session.ts";
import { getPool } from "../../../server/db.ts";
import { PageState } from "../../../ui/PageState.tsx";
import { t } from "../../../i18n/index.ts";
import { getIntegrationOverview } from "./data.ts";
import { describeIntegration } from "./status.ts";

/**
 * Integrations: every provider this milestone knows about, each shown with
 * the honest badge `describeIntegration` computes from real
 * `integration.status` evidence (P4 Task 9) -- never a fabricated "Connect"
 * button for a provider with no adapter, and never a badge claiming a
 * merely-configured row was actually verified (Global Constraint #13).
 */
export default async function IntegrationsPage() {
  let workspaceId;
  try {
    ({ workspaceId } = await requireWorkspace());
  } catch (error) {
    if (error instanceof UnauthorizedError) return <PageState kind="unauthorized" />;
    throw error;
  }

  let rows;
  try {
    rows = await getIntegrationOverview(getPool(), workspaceId);
  } catch {
    return <PageState kind="error" />;
  }

  if (rows.length === 0) {
    return <PageState kind="empty" detail={t("integrations.noProviders")} />;
  }

  return (
    <div>
      <h1 className="font-display" style={{ lineHeight: "var(--lh-heading)", margin: 0 }}>
        {t("integrations.title")}
      </h1>
      <p style={{ lineHeight: "var(--lh-body)", color: "var(--color-ink2)" }}>{t("integrations.intro")}</p>
      <ul>
        {rows.map((row) => {
          const description = describeIntegration(row);
          return (
            <li key={row.provider} data-testid={`integration-${row.provider}`} style={{ lineHeight: "var(--lh-body)" }}>
              <span>{description.label}</span>
              {" — "}
              <span data-testid={`integration-badge-${row.provider}`}>{description.badge}</span>
              {description.canConnect && (
                <>
                  {" "}
                  <button type="button">{t("integrations.connect")}</button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
