import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import QRCode from "qrcode";
import { assertAuthRateLimit, refundAuthRateLimit } from "@/lib/auth/rate-limit";
import { SESSION_COOKIE, startMfaEnrollment } from "@/lib/auth/session";
import { assertSameOrigin, errorResponse } from "@/lib/server/api";

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    await assertAuthRateLimit(req, "mfa_enroll");
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    const r = token ? await startMfaEnrollment(token) : null;
    if (!r) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
    refundAuthRateLimit(req);
    const qrSvg = await QRCode.toString(r.otpauthUrl, { type: "svg", margin: 1, width: 220 });
    return NextResponse.json({ secret: r.secret, otpauthUrl: r.otpauthUrl, qrSvg });
  } catch (e) {
    return errorResponse(e);
  }
}
