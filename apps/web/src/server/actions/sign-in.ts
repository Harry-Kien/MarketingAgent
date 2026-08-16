"use server";

import { redirect } from "next/navigation";
import { auth } from "../auth.ts";

/**
 * The one real entry point a browser can reach to start a session. Bound as
 * a Next.js Server Action from `apps/web/src/app/login/page.tsx`'s
 * `<form action={signIn}>`. `nextCookies()` (auth.ts's plugin list) sets the
 * session cookie on the response automatically once `auth.api.signInEmail`
 * succeeds -- there is no separate cookie-setting step here.
 *
 * Deliberately does not distinguish "no such email" from "wrong password"
 * in what it shows the caller (one generic `invalidCredentials` message,
 * via the redirect's `error=1` query param) -- the same
 * no-existence-leak posture `getCampaign`'s own doc comment
 * (apps/web/src/server/queries.ts) already applies to workspace-scoped
 * data, applied here to accounts.
 */
export async function signIn(formData: FormData): Promise<void> {
  const email = formData.get("email");
  const password = formData.get("password");
  if (typeof email !== "string" || typeof password !== "string" || email.length === 0 || password.length === 0) {
    redirect("/login?error=1");
  }

  try {
    await auth.api.signInEmail({ body: { email, password } });
  } catch {
    redirect("/login?error=1");
  }

  redirect("/");
}
