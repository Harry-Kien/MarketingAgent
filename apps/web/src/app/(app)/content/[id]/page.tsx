import { isId } from "@smos/domain";
import { requireWorkspace } from "../../../../server/auth.ts";
import { UnauthorizedError } from "../../../../server/session.ts";
import { getPool } from "../../../../server/db.ts";
import { getContentItem } from "../../../../server/queries.ts";
import { PageState } from "../../../../ui/PageState.tsx";
import { t } from "../../../../i18n/index.ts";

/**
 * Content Studio: one content item, its latest version (what will actually
 * be published -- `publicationContent`, distinct from the working `body`),
 * and every citation that backs it. `id` is the content item id from the
 * URL; the workspace it is read inside comes exclusively from
 * `requireWorkspace()`, never from this route parameter.
 */
export default async function ContentItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let workspaceId;
  try {
    ({ workspaceId } = await requireWorkspace());
  } catch (error) {
    if (error instanceof UnauthorizedError) return <PageState kind="unauthorized" />;
    throw error;
  }

  if (!isId(id)) {
    return <PageState kind="empty" detail={t("content.notFound")} />;
  }

  let item;
  try {
    item = await getContentItem(getPool(), workspaceId, id);
  } catch {
    return <PageState kind="error" />;
  }

  if (item === null) {
    return <PageState kind="empty" detail={t("content.notFound")} />;
  }

  if (item.latestVersion === null) {
    // A content item with no version yet: not an error, not "not found" --
    // a real, distinct state (partial-data: the item exists, its content
    // does not yet).
    return <PageState kind="partial" detail={t("content.notFound")} />;
  }

  const version = item.latestVersion;

  return (
    <div>
      <h1 className="font-display" style={{ lineHeight: "var(--lh-heading)", margin: 0 }}>
        {item.title}
      </h1>
      <p style={{ color: "var(--color-ink2)" }}>
        {t("content.version")}: {version.versionNumber}
      </p>

      <section>
        <h2 className="font-display" style={{ lineHeight: "var(--lh-heading)" }}>
          {t("content.publicationContent")}
        </h2>
        {version.publicationContent === null ? (
          <p style={{ color: "var(--color-ink2)" }}>{t("state.partial")}</p>
        ) : (
          <p style={{ whiteSpace: "pre-wrap", lineHeight: "var(--lh-body)" }}>{version.publicationContent}</p>
        )}
      </section>

      <section>
        <h2 className="font-display" style={{ lineHeight: "var(--lh-heading)" }}>
          {t("content.citations")}
        </h2>
        {version.citations.length === 0 ? (
          <p style={{ color: "var(--color-ink2)" }}>{t("approval.missingEvidence")}</p>
        ) : (
          <ul>
            {version.citations.map((citation) => (
              <li key={citation.id} style={{ lineHeight: "var(--lh-body)" }}>
                <a href={citation.url} style={{ color: "var(--color-cham)" }}>
                  {citation.url}
                </a>{" "}
                — {citation.accessedAt.toISOString()}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
