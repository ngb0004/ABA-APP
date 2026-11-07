import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { logout, SESSION_COOKIE } from "@/lib/auth/session";
import { assertSameOrigin, errorResponse } from "@/lib/server/api";

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const jar = await cookies();
    await logout(jar.get(SESSION_COOKIE)?.value);
    const res = NextResponse.json({ ok: true });
    res.cookies.delete(SESSION_COOKIE);
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
