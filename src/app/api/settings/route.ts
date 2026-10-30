import { api, readJson } from "@/lib/server/api";
import { updateSettings } from "@/lib/services/records";

const Any = { parse: (x: unknown) => x };

export const PUT = api(async (req, ctx) => updateSettings(ctx, await readJson(req, Any)));
