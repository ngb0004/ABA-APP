import { api, readJson } from "@/lib/server/api";
import { saveDiagnosis } from "@/lib/services/records";

const Any = { parse: (x: unknown) => x };

export const POST = api<{ id: string }>(async (req, ctx, { id }) =>
  saveDiagnosis(ctx, id, null, await readJson(req, Any)),
);
