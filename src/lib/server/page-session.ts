import "server-only";
import { notFound, redirect } from "next/navigation";
import { currentSession } from "./current-session";
import type { OrgCtx } from "../db";
import { loadOr404 } from "./not-found";

/** For server components: a fully authenticated org context, or redirect to login. */
export async function requirePageCtx(): Promise<
  OrgCtx & { role: NonNullable<OrgCtx["role"]>; isPlatformCurator: boolean }
> {
  const r = await currentSession();
  const s = r.session;
  if (r.ended === "idle") redirect("/login?reason=idle");
  if (!s || !s.orgId || !s.role) redirect("/login");
  return { orgId: s.orgId, userId: s.userId, role: s.role, isPlatformCurator: s.isPlatformCurator };
}

export { asOfToday } from "./as-of";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Loads the record a page is about. A well-formed id that matches nothing (deleted, or another
 * org's row hidden by RLS) shows the normal 404 page instead of a server error.
 */
export function orNotFound<T>(load: () => Promise<T>): Promise<T> {
  return loadOr404(load, notFound);
}

/** Route ids are UUIDs; anything else is a 404, not a server error. */
export async function uuidParam(params: Promise<{ id: string }>): Promise<string> {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return id;
}
