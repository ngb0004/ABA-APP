import "server-only";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getSessionByToken, SESSION_COOKIE } from "../auth/session";
import type { OrgCtx } from "../db";

/** For server components: a fully authenticated org context, or redirect to login. */
export async function requirePageCtx(): Promise<OrgCtx & { role: NonNullable<OrgCtx["role"]> }> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const s = await getSessionByToken(token);
  if (!s || !s.orgId || !s.role) redirect("/login");
  return { orgId: s.orgId, userId: s.userId, role: s.role };
}

export { asOfToday } from "./as-of";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route ids are UUIDs; anything else is a 404, not a server error. */
export async function uuidParam(params: Promise<{ id: string }>): Promise<string> {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return id;
}
