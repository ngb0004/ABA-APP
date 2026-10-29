import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { confirmMfaEnrollment, getSessionByToken, SESSION_COOKIE } from "@/lib/auth/session";
import { assertSameOrigin, errorResponse } from "@/lib/server/api";

const Body = z.object({ code: z.string().regex(/^\d{6}$/) });

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const { code } = Body.parse(await req.json());
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
    const s = await confirmMfaEnrollment(token, code);
    if (!s) {
      // Too many wrong codes ends the sign-in; the password must be entered again.
      const ended = !(await getSessionByToken(token, { allowUnverified: true }));
      const error = ended
        ? "Too many incorrect codes. Sign in again."
        : "That code didn't match. Check the time on your phone and try the newest code.";
      return NextResponse.json({ error }, { status: 401 });
    }
    return NextResponse.json({ ok: true, role: s.role });
  } catch (e) {
    return errorResponse(e);
  }
}
