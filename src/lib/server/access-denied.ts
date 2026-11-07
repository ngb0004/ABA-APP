import { audit } from "../audit";
import { withOrg, type OrgCtx } from "../db";
import { HttpError, log } from "../log";

const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The route with record ids replaced: "/api/plans/:id/export". Ids are kept separately. */
export function routePattern(path: string): { route: string; targetIds: string[] } {
  const p = path.split("?")[0] ?? "";
  return { route: p.replace(UUID_G, ":id"), targetIds: (p.match(UUID_G) ?? []).slice(0, 5) };
}

/** Statuses that are refusals worth reviewing: not signed in, not allowed, or no such record here. */
export const DENIED_STATUSES = new Set([401, 403, 404]);

/**
 * Records a refused request (164.312(b), activity review): an `access:denied` audit row in its own
 * transaction, so it survives the rollback of the refused work, and a scrubbed warning line for the
 * log alarms. Without a signed-in org (401, cross-origin) there is no one to attribute the row to,
 * so only the log line is written. Never throws: a failed audit must not change the response.
 */
export async function recordAccessDenied(
  ctx: OrgCtx | null,
  info: { status: number; method: string; path: string; error?: unknown },
) {
  const { route, targetIds } = routePattern(info.path);
  // ForbiddenError messages are "Forbidden: <action>"; the action name is not PHI.
  const action =
    info.error instanceof HttpError && /^Forbidden: [\w:]+$/.test(info.error.message)
      ? info.error.message.slice("Forbidden: ".length)
      : null;
  log.warn("Access denied", { status: info.status, method: info.method, route, action });
  if (!ctx) return;
  try {
    await withOrg(ctx, (tx) =>
      audit(tx, {
        action: "access:denied",
        entityType: "Route",
        entityId: targetIds[0] ?? null,
        meta: {
          status: info.status,
          method: info.method,
          route,
          targetIds,
          permission: action,
          role: ctx.role,
        },
      }),
    );
  } catch {
    log.error("Could not record a denied access", { status: info.status, route });
  }
}
