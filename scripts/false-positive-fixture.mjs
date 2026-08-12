// A realistic component source exercising ordinary idioms that must never
// trip ANY of the three design-constraint checks or the i18n guard. This is
// the permanent regression net fix round 2 was asked to build: every fix
// round from here on must keep this fixture producing zero findings from
// all four guard functions, or it has re-introduced a false positive.
// Fix round 3 added a URL-bearing link (`href="https://..."` contains `//`,
// which used to blank the rest of its line) and a TSX generic component
// instantiation (`<Select<string> ...>`, which used to truncate the tag
// scan) -- both ordinary code, both previously reachable false-negative
// vectors, now permanently exercised here. Fix round 4 added single-quoted
// attributes (`type='button'`, `data-testid='...'`) -- previously invisible
// to the i18n guard's attribute matcher entirely, regardless of visibility.
export const FALSE_POSITIVE_FIXTURE = `
import { t } from "../i18n/index.ts";

/**
 * CampaignCard -- ordinary idioms only: structural attributes, English
 * fallback/log strings inside comments, numbers and dates, t() in text,
 * attribute and template-key position, a legitimate single-line badge, a
 * reviewed suppression, and a code sample containing a middot.
 */
export function CampaignCard({ score, threshold, name }: Props) {
  // Separator idiom: use — (em dash, Archivo has it), not ·, in an
  // Archivo label. Example of what NOT to do: "Đã đăng · Bị chặn".
  return (
    <div
      id="campaign-card"
      key={name}
      className="rounded-md border font-body leading-normal"
      data-testid="đã-đăng-card"
      data-cy="nút-huỷ"
      role="article"
      href="/chien-dich/xem-them"
      aria-describedby="mo-ta-loi-campaign-card"
    >
      <span className="font-display leading-[1.3]">{t("campaign.title")}</span>
      <Badge
        variant={score > threshold ? "good" : "bad"}
        aria-label={t("approval.approve")}
        placeholder={t("campaign.title")}
      />
      <p className="leading-relaxed">
        {t("home.needsYou")} -- updated 12/08/2026, 45.000.000 VND, 12,5%
      </p>
      <code className="font-mono leading-[1.4]">
        {"const sep = \\"\\u00b7\\"; // a middot in a code sample, not display text"}
      </code>
      <span className="badge" style={{ height: 32, lineHeight: "32px" }}>
        {t("state.retry")}
      </span>
      <div
        className="badge2"
        style={{ lineHeight: "20px" /* c1-ok: single-line pill, verified no wrap at any viewport, 2026-08-12 */ }}
      >
        {t("state.loading")}
      </div>
      <img alt={t("home.title")} src="/logo.svg" />
      <input placeholder={t("campaign.title")} />
      <span className="font-display">{/* separator uses · like this, documentation only */}</span>
      <span className="font-display">{t("nav.today")} — {t("nav.campaigns")}</span>
      <span className="sr-only">{count} items</span>
      <a href="https://smos.example.com/chien-dich?ref=share" aria-label={t("approval.approve")}>
        {t("nav.campaigns")}
      </a>
      <Select<string> options={statusOptions} placeholder={t("campaign.title")} />
      <button type='button' className='btn' data-testid='huỷ-button' aria-label={t("approval.reject")}>
        {t("approval.reject")}
      </button>
    </div>
  );
}
`;
