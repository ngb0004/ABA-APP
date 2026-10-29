import { NextResponse } from "next/server";
import { z } from "zod";
import { loginWithPassword, SESSION_COOKIE } from "@/lib/auth/session";
import { assertSameOrigin, errorResponse } from "@/lib/server/api";

const Body = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const { email, password } = Body.parse(await req.json());
    const r = await loginWithPassword(email, password);
    if (!r) return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    const res = NextResponse.json({ mfaRequired: true, mfaEnrolled: r.mfaEnabled });
    res.cookies.set(SESSION_COOKIE, r.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 12 * 3600,
    });
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
