/**
 * Idle timeout: what counts as the person's activity.
 *
 * A session is signed out (deleted) when no activity was recorded for SESSION_IDLE_MINUTES. The
 * server records activity, at most once a minute per session, for:
 *  - page navigations (server-rendered requests), except router prefetches, which the browser makes
 *    on its own when links scroll into view (a page refresh the UI makes right after a save counts
 *    as well; it only follows a save the person caused);
 *  - API mutations (POST, PUT, PATCH, DELETE) the UI sends because someone clicked or submitted,
 *    except those it marks background with the `x-yoma-background: 1` header (goal autosave);
 *  - POST /api/auth/keepalive, which the UI sends at most once a minute while the person is
 *    actually typing, clicking, scrolling, or touching the page, and when they press
 *    "Stay signed in".
 * It never counts GET API requests (data loads and any polling) or GET /api/auth/session, which
 * the idle warning uses to read the time left. So a tab left open with background requests still
 * signs out, while someone typing a long note without saving stays signed in.
 */
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { authConfig, idleMessage, resolveSession, SESSION_COOKIE } from "./session";

/** Seconds before idle sign-out that the UI warns. */
export const IDLE_WARNING_SECONDS = 120;

export function isPrefetch(h: Headers): boolean {
  return (
    h.get("next-router-prefetch") === "1" ||
    h.get("purpose") === "prefetch" ||
    (h.get("sec-purpose") ?? "").includes("prefetch")
  );
}

/** Idle status for the warning: how long is left. `activity` only for the keep-alive. */
export async function idleStatusResponse(activity: boolean) {
  const r = await resolveSession((await cookies()).get(SESSION_COOKIE)?.value, { activity });
  if (!r.session?.orgId)
    return NextResponse.json(
      r.ended === "idle" ? { error: idleMessage(), signedOut: "idle" } : { error: "Not authenticated" },
      { status: 401 },
    );
  return NextResponse.json({
    idleRemainingSeconds: Math.max(0, Math.floor(r.idleRemainingMs / 1000)),
    idleTimeoutSeconds: authConfig().idleMinutes * 60,
  });
}

/** Whether this server-rendered request is a real navigation (not a prefetch). */
export async function isNavigationActivity(): Promise<boolean> {
  return !isPrefetch(await headers());
}
