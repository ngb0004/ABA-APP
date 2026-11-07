import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { isNavigationActivity } from "../auth/idle";
import { resolveSession } from "../auth/session";
import { SESSION_COOKIE } from "../auth/session";

/**
 * The session for this server render, looked up once per request (layout and page share it), so
 * an idle sign-out found by the layout still sends the page to /login with the reason.
 */
export const currentSession = cache(async () =>
  resolveSession((await cookies()).get(SESSION_COOKIE)?.value, { activity: await isNavigationActivity() }),
);
