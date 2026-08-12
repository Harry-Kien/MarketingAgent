import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "../../../../server/auth.ts";

// Mounts better-auth's own routes (sign-in, get-session, sign-out, ...) at
// /api/auth/*. Sign-up is configured unreachable at the `auth` instance
// itself (emailAndPassword.disableSignUp: true, apps/web/src/server/auth.ts)
// and would fail at the database even without that flag (smos_app has no
// INSERT on user_account, 0030_user_account_no_app_write.sql) -- this route
// mounts whatever better-auth exposes, it does not itself decide what is
// reachable.
export const { POST, GET } = toNextJsHandler(auth);
