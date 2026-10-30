import "server-only";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getSessionByToken, SESSION_COOKIE } from "../auth/session";
import type { OrgCtx } from "../db";
import { loadOr404 } from "./not-found";

/** For server components: a fully authenticated org context, or redirect to login. */
export async function requirePageCtx(): Promise<
  OrgCtx & { role: NonNullable<OrgCtx["role"]>; isPlatformCurator: boolean }
> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const s = await getSessionByToken(token);
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
