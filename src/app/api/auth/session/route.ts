import { idleStatusResponse } from "@/lib/auth/idle";
import { errorResponse } from "@/lib/server/api";

/** Time left before idle sign-out. Reading it is not activity. */
export async function GET() {
  try {
    return await idleStatusResponse(false);
  } catch (e) {
    return errorResponse(e);
  }
}
