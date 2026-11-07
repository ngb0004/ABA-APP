import { resolveSession, tokenFromCookieHeader } from "../auth/session";
import { HttpError, log } from "../log";
import { recordAccessDenied, routePattern } from "./access-denied";

/**
 * For src/instrumentation.ts: an error a page or server component threw. Only the error's name,
 * Next's digest and the route pattern are logged (never the message, which can hold query data).
 * A permission refusal is recorded as access:denied under the signed-in person.
 */
export async function reportRequestError(
  err: unknown,
  request: { path: string; method: string; headers: Record<string, string | string[] | undefined> },
) {
  const status = err instanceof HttpError ? err.status : null;
  if (status === 403 || status === 401) {
    const cookie = request.headers.cookie;
    const r = await resolveSession(
      tokenFromCookieHeader(Array.isArray(cookie) ? cookie.join("; ") : (cookie ?? null)),
    );
    const s = r.session;
    await recordAccessDenied(s?.orgId ? { orgId: s.orgId, userId: s.userId, role: s.role } : null, {
      status,
      method: request.method,
      path: request.path,
      error: err,
    });
    return;
  }
  log.error("Unhandled page error", {
    name: err instanceof Error ? err.name : typeof err,
    digest: (err as { digest?: unknown })?.digest ?? null,
    route: routePattern(request.path).route,
  });
}
