import { api } from "@/lib/server/api";
import { checkSourcesNow } from "@/lib/services/rules-watch";

// Fetching public payor documents can take a while.
export const maxDuration = 120;

export const POST = api(async (_req, ctx) => ({ checks: await checkSourcesNow(ctx) }));
