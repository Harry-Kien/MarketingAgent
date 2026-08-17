import { isId } from "@smos/domain";
import { requireWorkspace } from "../../../../server/auth.ts";
import { UnauthorizedError } from "../../../../server/session.ts";
import { getPool } from "../../../../server/db.ts";
import { getCampaign } from "../../../../server/queries.ts";
import { PageState } from "../../../../ui/PageState.tsx";
import { StateRibbon } from "../../../../ui/StateRibbon.tsx";
import { tokens } from "../../../../ui/tokens.ts";
import { t } from "../../../../i18n/index.ts";

/**
 * Campaign Workspace. `id` comes from the URL, but the *workspace* it is
 * looked up inside never does -- `requireWorkspace()` resolves that from
 * the session, exactly like `(app)/page.tsx`. `getCampaign` runs inside
 * `withTenant`'s scope, so a campaign id belonging to a different workspace
 * cannot be read here no matter what: it comes back `null`, indistinguishable
 * from an id that never existed at all (E14), which this page renders as the
 * same `empty` PageState it would show for any other "nothing here" case --
 * it does not tell an attacker "wrong workspace" vs. "no such campaign".
 */
export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let workspaceId;
  try {
    ({ workspaceId } = await requireWorkspace());
  } catch (error) {
    if (error instanceof UnauthorizedError) return <PageState kind="unauthorized" />;
    throw error;
  }

  // A malformed id can never be a real campaign in any workspace, so it is
  // refused the same way as "not found" -- no different code path, no
  // different message, nothing for a client to distinguish by probing.
  if (!isId(id)) {
    return <PageState kind="empty" detail={t("campaign.notFound")} />;
  }

  let campaign;
  try {
    campaign = await getCampaign(getPool(), workspaceId, id);
  } catch {
    return <PageState kind="error" />;
  }

  if (campaign === null) {
    return <PageState kind="empty" detail={t("campaign.notFound")} />;
  }

  return (
    <div>
      {/* overflowWrap: campaign.name is founder-entered free text with no
          guaranteed spaces (E7's real mobile screenshot caught this live
          with a long hyphenated name); without it, one long unbroken run of
          characters refuses to wrap and pushes the whole page wider than a
          390px viewport instead of breaking onto a second line. */}
      <h1 className="font-display" style={{ lineHeight: "var(--lh-heading)", margin: 0, overflowWrap: "anywhere" }}>
        {campaign.name}
      </h1>
      {/* The ribbon has eleven fixed stops, so it is intrinsically wider than a
          390px viewport. It scrolls inside its own container rather than
          widening the document -- same treatment (app)/page.tsx gives its
          table. Caught by E7's real-browser mobile run, not by any unit test:
          nothing that renders to a string can observe a horizontal scrollbar. */}
      <div style={{ overflowX: "auto", marginTop: tokens.space[2], marginBottom: tokens.space[2] }}>
        <StateRibbon state={campaign.state} />
      </div>
      <dl>
        <dt>{t("campaign.lifecycle")}</dt>
        <dd>{t(`lifecycle.${campaign.state}`)}</dd>
        <dt>{t("campaign.updatedAt")}</dt>
        <dd>{campaign.updatedAt.toISOString()}</dd>
      </dl>
    </div>
  );
}
