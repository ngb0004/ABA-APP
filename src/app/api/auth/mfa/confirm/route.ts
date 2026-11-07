import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { assertAuthRateLimit, refundAuthRateLimit } from "@/lib/auth/rate-limit";
import {
  confirmMfaEnrollment,
  getSessionByToken,
  SESSION_COOKIE,
  SIGN_IN_FAILED_MESSAGE,
} from "@/lib/auth/session";
import { assertSameOrigin, errorResponse } from "@/lib/server/api";

const Body = z.object({ code: z.string().regex(/^\d{6}$/) });

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    await assertAuthRateLimit(req, "mfa_confirm");
    const { code } = Body.parse(await req.json());
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) return NextResponse.json({ error: "Sign in first", restart: true }, { status: 401 });
    const s = await confirmMfaEnrollment(token, code);
    if (!s) {
      const restart = !(await getSessionByToken(token, { allowUnverified: true }));
      const error = restart
        ? SIGN_IN_FAILED_MESSAGE
        : "That code didn't match. Check the time on your phone and try the newest code.";
      return NextResponse.json({ error, restart }, { status: 401 });
    }
    refundAuthRateLimit(req);
    return NextResponse.json({ ok: true, role: s.role });
  } catch (e) {
    return errorResponse(e);
  }
}
