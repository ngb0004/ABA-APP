import { api, readJson } from "@/lib/server/api";
import { addMember } from "@/lib/services/records";

const Any = { parse: (x: unknown) => x };

export const POST = api(async (req, ctx) => addMember(ctx, await readJson(req, Any)));
