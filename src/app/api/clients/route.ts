import { api, readJson } from "@/lib/server/api";
import { createClient } from "@/lib/services/records";

const Any = { parse: (x: unknown) => x };

export const POST = api(async (req, ctx) => createClient(ctx, await readJson(req, Any)));
