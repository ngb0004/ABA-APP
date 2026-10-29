import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
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
