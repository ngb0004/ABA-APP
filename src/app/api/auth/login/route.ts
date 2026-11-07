import { NextResponse } from "next/server";
import { z } from "zod";
import { assertAuthRateLimit, refundAuthRateLimit } from "@/lib/auth/rate-limit";
import {
  loginWithPassword,
  SESSION_COOKIE,
  sessionCookieOptions,
  SIGN_IN_FAILED_MESSAGE,
} from "@/lib/auth/session";
import { assertSameOrigin, errorResponse } from "@/lib/server/api";

const Body = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    await assertAuthRateLimit(req, "login");
    const { email, password } = Body.parse(await req.json());
    const r = await loginWithPassword(email, password);
    if (!r) return NextResponse.json({ error: SIGN_IN_FAILED_MESSAGE }, { status: 401 });
    refundAuthRateLimit(req);
    const res = NextResponse.json({
      mfaRequired: true,
      mfaEnrolled: r.mfaEnabled,
      mustChangePassword: r.mustChangePassword,
    });
    res.cookies.set(SESSION_COOKIE, r.token, sessionCookieOptions());
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
