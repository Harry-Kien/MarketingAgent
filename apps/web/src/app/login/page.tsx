import { t } from "../../i18n/index.ts";
import { signIn } from "../../server/actions/sign-in.ts";
import { tokens } from "../../ui/tokens.ts";

/**
 * The only unauthenticated route in the app besides the API handlers
 * themselves. Deliberately outside the `(app)` route group -- it must
 * render before a session exists, so it cannot sit behind
 * `requireWorkspace()` the way every real page does.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main style={{ maxWidth: 360, margin: "80px auto", padding: tokens.space[4] }}>
      <h1>{t("auth.title")}</h1>
      <form action={signIn}>
        <div style={{ marginBottom: tokens.space[2] }}>
          <label htmlFor="login-email">{t("auth.email")}</label>
          <br />
          <input id="login-email" name="email" type="email" required autoComplete="email" />
        </div>
        <div style={{ marginBottom: tokens.space[2] }}>
          <label htmlFor="login-password">{t("auth.password")}</label>
          <br />
          <input id="login-password" name="password" type="password" required autoComplete="current-password" />
        </div>
        <button type="submit">{t("auth.submit")}</button>
      </form>
      {error !== undefined && (
        <p role="alert" style={{ color: "var(--color-brick)" }}>
          {t("auth.invalidCredentials")}
        </p>
      )}
    </main>
  );
}
