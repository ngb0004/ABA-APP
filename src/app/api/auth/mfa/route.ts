import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { assertAuthRateLimit, refundAuthRateLimit } from "@/lib/auth/rate-limit";
import {
  getSessionByToken,
  SESSION_COOKIE,
  sessionCookieOptions,
  SIGN_IN_FAILED_MESSAGE,
  verifyMfa,
} from "@/lib/auth/session";
import { assertSameOrigin, errorResponse } from "@/lib/server/api";

const Body = z.object({ code: z.string().regex(/^\d{6}$/) });

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    await assertAuthRateLimit(req, "mfa");
    const { code } = Body.parse(await req.json());
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) return NextResponse.json({ error: "Sign in first", restart: true }, { status: 401 });
    const s = await verifyMfa(token, code);
    if (!s) {
      // A lockout ends pending sign-ins: the UI goes back to the password step. Same message either way.
      const restart = !(await getSessionByToken(token, { allowUnverified: true }));
      return NextResponse.json({ error: SIGN_IN_FAILED_MESSAGE, restart }, { status: 401 });
    }
    refundAuthRateLimit(req);
    // The pre-MFA token is retired: the signed-in session gets a new one.
    const res = NextResponse.json({ ok: true, role: s.role });
    res.cookies.set(SESSION_COOKIE, s.token, sessionCookieOptions());
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
