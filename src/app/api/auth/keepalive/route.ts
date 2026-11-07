import { idleStatusResponse } from "@/lib/auth/idle";
import { assertSameOrigin, errorResponse } from "@/lib/server/api";

/** The UI's keep-alive: sent on real interaction (at most once a minute) and by "Stay signed in". No PHI. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    return await idleStatusResponse(true);
  } catch (e) {
    return errorResponse(e);
  }
}
