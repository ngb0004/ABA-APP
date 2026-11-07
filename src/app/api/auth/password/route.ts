import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { assertAuthRateLimit, refundAuthRateLimit } from "@/lib/auth/rate-limit";
import {
  chooseOwnPassword,
  getSessionByToken,
  SESSION_COOKIE,
  SIGN_IN_FAILED_MESSAGE,
} from "@/lib/auth/session";
import { assertSameOrigin, errorResponse } from "@/lib/server/api";

const Body = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().max(400) });

/** First sign-in with a temporary password: the person chooses their own. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    await assertAuthRateLimit(req, "password_set");
    const { currentPassword, newPassword } = Body.parse(await req.json());
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) return NextResponse.json({ error: "Sign in first", restart: true }, { status: 401 });
    const r = await chooseOwnPassword(token, currentPassword, newPassword);
    if (!r) {
      const restart = !(await getSessionByToken(token, { allowUnverified: true }));
      return NextResponse.json({ error: SIGN_IN_FAILED_MESSAGE, restart }, { status: 401 });
    }
    refundAuthRateLimit(req);
    return NextResponse.json({ ok: true, mfaEnrolled: r.mfaEnabled });
  } catch (e) {
    return errorResponse(e);
  }
}
