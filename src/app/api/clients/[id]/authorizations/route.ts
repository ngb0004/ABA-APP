import { api, readJson } from "@/lib/server/api";
import { saveAuthorization } from "@/lib/services/records";

const Any = { parse: (x: unknown) => x };

export const POST = api<{ id: string }>(async (req, ctx, { id }) =>
  saveAuthorization(ctx, id, null, await readJson(req, Any)),
);
