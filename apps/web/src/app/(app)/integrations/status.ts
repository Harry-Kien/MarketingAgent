// P4 Task 9: "Integration status trung thực" (Global Constraint #13, "Không
// fake-success integration"). The reported status must reflect what has
// actually been VERIFIED, never what is merely CONFIGURED -- if the only
// evidence for a row is that it exists, the badge must not claim the
// integration works.
//
// `integration.status` (infra/migrations/0028_integration.sql) carries four
// values, each a genuinely different evidentiary claim, kept exactly as the
// database already constrains them rather than widened here:
//
//   - "not_implemented": no adapter exists for this provider at all
//     (packages/integrations has one: Meta). Never a connect affordance,
//     regardless of whatever a stored status value says -- gated on
//     IMPLEMENTED_PROVIDERS, not on the row.
//   - "disconnected": an adapter exists, nothing is configured yet.
//   - "connected": a credential_reference row exists -- evidence the
//     workspace CONFIGURED this integration, never evidence that it WORKS.
//     This is the exact case the task exists to guard: a row existing is
//     not proof of function, so its badge must say "configured", not
//     "connected" or "verified".
//   - "sandbox": the adapter has actually been exercised successfully
//     against the Meta sandbox (see apps/web/e2e/golden-sequence.test.ts,
//     P4 Task 8) -- the strongest claim this milestone can honestly make.
//
// There is deliberately no "verified in production" status value: M0/M1
// never uses a real credential or contacts the real Meta API (this task's
// own Non-Goals), so no row can ever earn that claim yet. Adding a status
// for a claim nothing can currently produce would only be a second,
// currently-unreachable way to lie later -- it is a decision for whichever
// milestone actually adds real credentials, not this one.
import { t } from "../../../i18n/index.ts";

export const IMPLEMENTED_PROVIDERS = ["meta"] as const;
export type ImplementedProvider = (typeof IMPLEMENTED_PROVIDERS)[number];

/** Every provider the Integrations page renders a row for, implemented or
 * not -- the honest, complete picture (Global Constraint #13's other half:
 * an unimplemented provider must still be listed, truthfully, not hidden). */
export const ALL_KNOWN_PROVIDERS = ["meta", "tiktok", "linkedin", "zalo", "youtube"] as const;
export type KnownProvider = (typeof ALL_KNOWN_PROVIDERS)[number];

const PROVIDER_LABELS: Record<string, string> = {
  meta: "Meta (Facebook & Instagram)",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  zalo: "Zalo",
  youtube: "YouTube",
};

export type IntegrationStatus = "not_implemented" | "disconnected" | "connected" | "sandbox";

export interface IntegrationRow {
  provider: string;
  status: IntegrationStatus;
}

export interface IntegrationDescription {
  label: string;
  badge: string;
  canConnect: boolean;
}

function isImplemented(provider: string): provider is ImplementedProvider {
  return (IMPLEMENTED_PROVIDERS as readonly string[]).includes(provider);
}

/** The one function that turns a raw `integration` row into what the UI is
 * allowed to claim. Every branch is a distinct, real evidentiary state --
 * none of them ever say "connected" or "hoạt động" for a provider whose
 * only evidence is a configured row (see the module header). */
export function describeIntegration(row: IntegrationRow): IntegrationDescription {
  const label = PROVIDER_LABELS[row.provider] ?? row.provider;

  // Gated on the provider itself, never on the stored status alone: a
  // data-entry mistake that set "connected" on a provider with no real
  // adapter must still be refused a connect affordance and still be
  // labelled honestly as not implemented.
  if (!isImplemented(row.provider)) {
    return { label, badge: t("integrations.badgeNotImplemented"), canConnect: false };
  }

  switch (row.status) {
    case "not_implemented":
      return { label, badge: t("integrations.badgeNotImplemented"), canConnect: false };
    case "sandbox":
      return { label, badge: t("integrations.badgeSandbox"), canConnect: false };
    case "connected":
      return { label, badge: t("integrations.badgeConnected"), canConnect: false };
    case "disconnected":
      return { label, badge: t("integrations.badgeDisconnected"), canConnect: true };
  }
}

/** The status an implemented-but-never-configured provider (or a
 * not-implemented one) gets when no `integration` row exists for it at all
 * -- used by the Integrations page to render every provider in
 * ALL_KNOWN_PROVIDERS honestly, including ones the workspace has never
 * touched. */
export function defaultStatusFor(provider: string): IntegrationStatus {
  return isImplemented(provider) ? "disconnected" : "not_implemented";
}
